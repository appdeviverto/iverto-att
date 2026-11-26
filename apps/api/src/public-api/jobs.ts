import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ApiJob, Employee, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { tenantState } from '../common/features';
import { PrismaService } from '../common/prisma.service';
import { rlsContext, rlsFromUser, runAsSystem } from '../common/rls';
import { BUCKETS, SupabaseService } from '../common/supabase.service';
import { localYmd, ymdOf } from '../common/time';
import { IsYmd } from '../common/validators';
import { EmployeesService } from '../employees/employees';
import { FIELDS } from '../employees/fields';
import { parseImportRows, ParsedRow } from '../employees/import';
import { employmentTypesOf } from '../org/org';
import { ReportsService } from '../reports/reports';
import { apiKeyPrincipal } from './api-key.guard';
import { PolicyService } from './policy';
import { JOB_TYPES, JobType, PUBLIC_REPORT_TYPES } from './registry';

export const JOB_RETENTION_DAYS = 30;
const CHUNK = 100;
const LEASE_MS = 5 * 60_000;
const DOWNLOAD_URL_SECONDS = 15 * 60;
const DAY_MS = 86_400_000;

// ── Bulk upsert: the public record shape ────────────────────────────────────

/** Fields any employees:write key may set. Record keys map onto the CSV import's columns. */
const BASIC = ['fullName', 'joinedOn', 'designation', 'employmentType', 'mobilePunch', 'email', 'phone', 'probationEndOn', 'confirmedOn', 'noticePeriodDays'];
/** Personal / statutory / bank fields: only keys with PII access. */
export const PII_FIELDS = FIELDS.filter((f) => !f.virtual && f.section !== 'Salary' && f.key !== 'employeeCode' && !BASIC.includes(f.key)).map((f) => f.key);
/** Public name → import column. Ids are accepted where the CSV takes names. */
const REFS: Record<string, string> = { siteId: 'siteName', departmentId: 'departmentName', managerEmployeeCode: 'managerCode' };
const MATCH = ['employeeCode', 'externalId'];

export class BulkUpsertDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @IsObject({ each: true }) records: Record<string, unknown>[];
  /** Check every record and report what would happen; write nothing. */
  @IsOptional() @IsBoolean() validateOnly?: boolean;
  /** skip (default): apply valid records, report invalid ones. reject: any invalid record → nothing is written. */
  @IsOptional() @IsIn(['skip', 'reject']) onInvalid?: 'skip' | 'reject';
}

class ReportFiltersDto {
  @IsYmd() dateFrom: string;
  @IsYmd() dateTo: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) siteIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) departmentIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) employeeIds?: string[];
  @IsOptional() @IsIn(['none', 'department', 'site']) groupBy?: 'none' | 'department' | 'site';
}

export class CreateReportDto {
  @IsIn(PUBLIC_REPORT_TYPES) type: string;
  @IsIn(['csv', 'pdf']) format: 'csv' | 'pdf';
  @ValidateNested() @Type(() => ReportFiltersDto) filters: ReportFiltersDto;
}

export class JobListQuery {
  @IsOptional() @IsIn(Object.keys(JOB_TYPES)) type?: string;
  @IsOptional() @IsString() @MaxLength(64) cursor?: string;
}

interface BulkInput {
  records: Record<string, string | number | null>[];
  validateOnly: boolean;
  onInvalid: 'skip' | 'reject';
}

type RowStatus = 'created' | 'updated' | 'unchanged' | 'failed' | 'skipped';
interface RowError {
  field: string | null;
  code?: string;
  message: string;
}
interface RowResult {
  index: number;
  status: RowStatus;
  id: string | null;
  errors: RowError[];
}

/** Shape checks done at submit time, so a 202 means every record is well-formed. */
export function checkRecords(records: Record<string, unknown>[], piiAccess: boolean) {
  const allowed = new Set([...MATCH, ...BASIC, ...Object.keys(REFS), ...(piiAccess ? PII_FIELDS : [])]);
  const problems: Array<{ index: number; field: string; message: string }> = [];
  records.forEach((r, index) => {
    if (!MATCH.some((k) => typeof r[k] === 'string' && (r[k] as string).trim())) problems.push({ index, field: 'employeeCode', message: 'employeeCode or externalId is required' });
    for (const [field, v] of Object.entries(r)) {
      if (!allowed.has(field)) {
        problems.push({ index, field, message: PII_FIELDS.includes(field) ? 'needs a key with PII access' : 'unknown field' });
      } else if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
        problems.push({ index, field, message: 'must be a string, number or null' });
      } else if (typeof v === 'string' && (v.length > 500 || v.trim() === '-')) {
        problems.push({ index, field, message: v.length > 500 ? 'is longer than 500 characters' : 'use null to clear a field' });
      } else if (v === null && MATCH.includes(field)) {
        problems.push({ index, field, message: 'cannot be null' });
      }
    }
  });
  return problems;
}

// ── Presenter (contract) ────────────────────────────────────────────────────

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class ApiJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyService,
    private readonly reports: ReportsService,
    private readonly supabase: SupabaseService,
  ) {}

  private visibleTypes(user: AuthUser) {
    return (Object.entries(JOB_TYPES) as Array<[JobType, string]>).filter(([, perm]) => user.apiKey!.permissions.includes(perm as never)).map(([t]) => t);
  }

  async submitBulk(user: AuthUser, dto: BulkUpsertDto) {
    const { policy } = await this.policies.forTenant(user.tenantId);
    if (dto.records.length > policy.bulk.maxRecordsPerRequest) {
      throw new AppError(400, 'TOO_MANY_RECORDS', `At most ${policy.bulk.maxRecordsPerRequest} records per request`);
    }
    const problems = checkRecords(dto.records, user.apiKey!.piiAccess);
    if (problems.length) throw new AppError(400, 'VALIDATION_FAILED', `Record ${problems[0].index}: ${problems[0].field} ${problems[0].message}`, problems.slice(0, 100));
    const running = await this.prisma.apiJob.count({ where: { tenantId: user.tenantId, type: 'employees.bulk_upsert', status: { in: ['QUEUED', 'RUNNING'] } } });
    if (running >= policy.bulk.concurrentJobs) {
      throw new AppError(409, 'JOB_LIMIT_REACHED', `Your organisation may run ${policy.bulk.concurrentJobs} bulk job${policy.bulk.concurrentJobs === 1 ? '' : 's'} at a time; wait for it to finish`);
    }
    const input: BulkInput = { records: dto.records as BulkInput['records'], validateOnly: dto.validateOnly ?? false, onInvalid: dto.onInvalid ?? 'skip' };
    const job = await this.prisma.apiJob.create({
      data: {
        tenantId: user.tenantId,
        apiKeyId: user.apiKey!.id,
        type: 'employees.bulk_upsert',
        input: input as unknown as Prisma.InputJsonValue,
        progress: { processed: 0, total: dto.records.length },
        expiresAt: new Date(Date.now() + JOB_RETENTION_DAYS * DAY_MS),
      },
    });
    return this.present(job, false);
  }

  /** The ReportJob runs on the existing report queue; the job row is linked before it's queued. */
  async submitReport(user: AuthUser, dto: CreateReportDto) {
    let job: ApiJob | undefined;
    await this.reports.requestExport(user, { type: dto.type, format: dto.format, filters: dto.filters }, undefined, async (reportJobId) => {
      job = await this.prisma.apiJob.create({
        data: {
          tenantId: user.tenantId,
          apiKeyId: user.apiKey!.id,
          type: 'report',
          input: { ...dto } as unknown as Prisma.InputJsonValue,
          reportJobId,
          expiresAt: new Date(Date.now() + JOB_RETENTION_DAYS * DAY_MS),
        },
      });
    });
    return this.present(job!, false);
  }

  async get(user: AuthUser, id: string) {
    const job = await this.prisma.apiJob.findFirst({ where: { id, tenantId: user.tenantId, type: { in: this.visibleTypes(user) } } });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Job not found');
    return this.present(job, true);
  }

  async list(user: AuthUser, q: JobListQuery) {
    const types = this.visibleTypes(user).filter((t) => !q.type || t === q.type);
    const rows = await this.prisma.apiJob.findMany({
      where: { tenantId: user.tenantId, type: { in: types } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    });
    const page = rows.slice(0, 50);
    return {
      object: 'list',
      data: await Promise.all(page.map((j) => this.present(j, false))),
      hasMore: rows.length > 50,
      nextCursor: rows.length > 50 ? page[page.length - 1].id : null,
    };
  }

  /** The job contract (§12). Internal statuses never leak; a report's download URL is minted per GET. */
  async present(job: ApiJob, withDownload: boolean) {
    let result: unknown = job.result;
    let error = job.error as { code: string; message: string } | null;
    if (job.type === 'report' && job.reportJobId) {
      const r = await this.prisma.reportJob.findUnique({ where: { id: job.reportJobId }, select: { status: true, rowCount: true, sha256: true, storageKey: true, format: true } });
      result = null;
      if (r?.status === 'READY' && r.storageKey) {
        const url = withDownload ? await this.supabase.signedUrl(BUCKETS.reports(), r.storageKey, DOWNLOAD_URL_SECONDS, `${job.id}.${r.format}`) : null;
        result = { format: r.format, rowCount: r.rowCount, sha256: r.sha256, downloadUrl: url, urlExpiresAt: url ? new Date(Date.now() + DOWNLOAD_URL_SECONDS * 1000).toISOString() : null, expired: false };
      } else if (r?.status === 'EXPIRED') {
        result = { format: r.format, rowCount: r.rowCount, sha256: r.sha256, downloadUrl: null, urlExpiresAt: null, expired: true };
      }
      if (job.status === 'FAILED') error = { code: 'REPORT_FAILED', message: 'The report could not be generated; try again or contact support' };
    }
    return {
      object: 'job' as const,
      id: job.id,
      type: job.type,
      status: job.status.toLowerCase(),
      progress: job.type === 'report' ? null : job.progress,
      result,
      error,
      createdAt: iso(job.createdAt),
      startedAt: iso(job.startedAt),
      completedAt: iso(job.completedAt),
      expiresAt: iso(job.expiresAt),
    };
  }

  purge() {
    return runAsSystem(() => this.prisma.apiJob.deleteMany({ where: { expiresAt: { lt: new Date() } } }));
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────

class JobAbort extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const rowError = (err: unknown): RowError => {
  if (err instanceof HttpException) {
    const r = err.getResponse() as { code?: string; message?: string };
    return { field: null, code: r.code ?? 'ERROR', message: r.message ?? err.message };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { field: null, code: 'DUPLICATE', message: 'Conflicts with an existing employee' };
  return { field: null, code: 'INTERNAL', message: 'Could not save this record' };
};

/** Value as the import would write it vs the stored column, for "unchanged". */
function same(e: Employee, key: string, v: string | number | null) {
  const cur = (e as unknown as Record<string, unknown>)[key];
  const norm = cur instanceof Date ? ymdOf(cur) : (cur ?? null);
  return key === 'email' ? (norm as string | null)?.toLowerCase() === (v as string | null)?.toLowerCase() : norm === v;
}

/**
 * Runs bulk upserts one at a time per process, from a lease on the job row (a crashed worker's
 * lease expires and the job resumes from its checkpoint). Each chunk of 100 re-checks the key:
 * revoking it, or the platform tightening the policy, stops the job.
 */
@Injectable()
export class ApiJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApiJobWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyService,
    private readonly employees: EmployeesService,
    private readonly audit: AuditableActionService,
  ) {}

  onModuleInit() {
    if (process.env.API_JOB_WORKER === 'off') return;
    this.schedule(3000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        while (!this.stopped && (await this.runNext()));
      } catch (err) {
        this.logger.error(`Job worker: ${(err as Error).message}`);
      }
      this.schedule(2000);
    }, ms);
  }

  /** Claims and runs one bulk job; false when there is none. */
  async runNext(): Promise<boolean> {
    if ((await this.policies.platform()).killSwitch) return false;
    const [claimed] = await runAsSystem(() =>
      this.prisma.$transaction((tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          UPDATE api_jobs SET status = 'RUNNING', locked_until = (now() AT TIME ZONE 'UTC') + ${`${LEASE_MS / 1000} seconds`}::interval,
            started_at = COALESCE(started_at, now() AT TIME ZONE 'UTC')
          WHERE id = (
            SELECT id FROM api_jobs WHERE type = 'employees.bulk_upsert'
              AND (status = 'QUEUED' OR (status = 'RUNNING' AND locked_until < now() AT TIME ZONE 'UTC'))
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id`,
      ),
    );
    if (!claimed) return false;
    const job = await runAsSystem(() => this.prisma.apiJob.findUniqueOrThrow({ where: { id: claimed.id } }));
    try {
      await this.runBulk(job);
    } catch (err) {
      const e = err instanceof JobAbort ? { code: err.code, message: err.message } : { code: 'INTERNAL', message: 'The job failed unexpectedly; no further records were processed' };
      if (!(err instanceof JobAbort)) this.logger.error(`Job ${job.id}: ${(err as Error).stack}`);
      await this.save(job.id, { status: 'FAILED', error: e, completedAt: new Date(), lockedUntil: null });
    }
    return true;
  }

  private save(id: string, data: Prisma.ApiJobUpdateInput) {
    return runAsSystem(() => this.prisma.apiJob.update({ where: { id }, data }));
  }

  /** The key's caller, re-checked: revoked/disabled/expired keys and tightened policies stop the job. */
  private async principal(job: ApiJob): Promise<AuthUser> {
    const key = await runAsSystem(() => this.prisma.apiKey.findUnique({ where: { id: job.apiKeyId } }));
    if (!key || key.status !== 'ACTIVE' || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
      throw new JobAbort('API_KEY_INACTIVE', 'The key that started this job was revoked, disabled or expired');
    }
    const [tenant, { policy }] = await Promise.all([tenantState(this.prisma, job.tenantId), this.policies.forTenant(job.tenantId)]);
    if (tenant.status !== 'ACTIVE' || !policy.enabled) throw new JobAbort('API_DISABLED', 'API access is no longer enabled for this organisation');
    const user = apiKeyPrincipal(key, policy);
    if (!user.apiKey!.permissions.includes(JOB_TYPES['employees.bulk_upsert'])) {
      throw new JobAbort('BLOCKED_BY_POLICY', 'employees:write is no longer allowed for this key');
    }
    return user;
  }

  private async runBulk(job: ApiJob) {
    const input = job.input as unknown as BulkInput;
    const user = await this.principal(job);
    const tenantId = job.tenantId;

    // Lookups see the whole tenant (like the CSV import), so a code in another site is an
    // update the key's scope then refuses, never a duplicate.
    const [sites, departments, existing, tenant] = await runAsSystem(() =>
      Promise.all([
        this.prisma.site.findMany({ where: { tenantId }, select: { id: true, name: true } }),
        this.prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } }),
        this.prisma.employee.findMany({ where: { tenantId }, select: { id: true, employeeCode: true, externalId: true } }),
        this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } }),
      ]),
    );
    const byCode = new Map(existing.map((e) => [e.employeeCode.toLowerCase(), e]));
    const byExternal = new Map(existing.filter((e) => e.externalId).map((e) => [e.externalId!, e]));

    // externalId → employeeCode, and externalId conflicts, before the import's own checks.
    const pre: RowError[][] = input.records.map(() => []);
    const seenExternal = new Map<string, number>();
    const records = input.records.map((r, i) => {
      const ext = typeof r.externalId === 'string' ? r.externalId.trim() : undefined;
      let code = typeof r.employeeCode === 'string' ? r.employeeCode.trim() : '';
      if (ext !== undefined) {
        const owner = byExternal.get(ext);
        if (!code && owner) code = owner.employeeCode;
        if (!code) pre[i].push({ field: 'employeeCode', message: 'No employee has this externalId; employeeCode is needed to create one' });
        else if (owner && owner.employeeCode.toLowerCase() !== code.toLowerCase()) pre[i].push({ field: 'externalId', message: 'externalId belongs to another employee' });
        if (seenExternal.has(ext)) pre[i].push({ field: 'externalId', message: `externalId repeated (record ${seenExternal.get(ext)})` });
        seenExternal.set(ext, i);
        if (ext.length > 128) pre[i].push({ field: 'externalId', message: 'externalId is longer than 128 characters' });
      }
      return { ...r, employeeCode: code, externalId: ext };
    });

    // Records → the CSV import's rows: one validator for both (blank = keep, "-" = clear).
    const columns = ['employeeCode', ...new Set(records.flatMap((r) => Object.keys(r)).filter((k) => !MATCH.includes(k)))];
    const header = columns.map((k) => REFS[k] ?? k);
    const cell = (v: unknown) => (v === undefined ? '' : v === null ? '-' : String(v));
    const { parsed } = parseImportRows([header, ...records.map((r) => columns.map((k) => cell((r as Record<string, unknown>)[k])))], {
      mode: 'UPSERT',
      sites,
      departments,
      existing: new Map(existing.map((e) => [e.employeeCode.toLowerCase(), { id: e.id }])),
      categories: employmentTypesOf(tenant.settings),
      structures: [],
      today: localYmd(new Date(), (tenant.settings as { timezone?: string })?.timezone || 'Asia/Kolkata'),
      noSalary: true,
    });
    parsed.forEach((p, i) => p.errors.unshift(...pre[i]));
    const fieldName = (f: string) => Object.entries(REFS).find(([, v]) => v === f)?.[0] ?? f;

    // "unchanged": every given value already stored, so nothing is written and no event fires.
    const current = new Map(
      (await runAsSystem(() => this.prisma.employee.findMany({ where: { tenantId, id: { in: parsed.filter((p) => p.id).map((p) => p.id!) } } }))).map((e) => [e.id, e]),
    );
    const codeToId = new Map(existing.map((e) => [e.employeeCode.toLowerCase(), e.id]));
    const unchanged = (p: ParsedRow, i: number) => {
      const e = p.id ? current.get(p.id) : undefined;
      if (!e) return false;
      const managerSame = p.managerCode === undefined || (p.managerCode === null ? e.managerId === null : codeToId.get(p.managerCode.toLowerCase()) === e.managerId);
      return managerSame && (records[i].externalId === undefined || records[i].externalId === e.externalId) && Object.entries(p.data).every(([k, v]) => same(e, k, v));
    };

    const results: RowResult[] = (job.result as { rows?: RowResult[] } | null)?.rows ?? [];
    const invalid = parsed.some((p) => p.errors.length);
    const failed = (p: ParsedRow, i: number): RowResult => ({ index: i, status: 'failed', id: p.id ?? null, errors: p.errors.map((e) => ({ field: fieldName(e.field), message: e.message })) });

    if (input.validateOnly || (invalid && input.onInvalid === 'reject')) {
      const rows = parsed.map((p, i): RowResult =>
        p.errors.length ? failed(p, i) : { index: i, status: input.validateOnly ? (p.op === 'CREATE' ? 'created' : unchanged(p, i) ? 'unchanged' : 'updated') : 'skipped', id: p.id ?? null, errors: [] },
      );
      const rejected = !input.validateOnly;
      await this.finish(job, rows, rejected ? { code: 'VALIDATION_FAILED', message: 'Some records are invalid; nothing was written (onInvalid: reject)' } : null);
      return;
    }

    await rlsContext.run(rlsFromUser(user), async () => {
      for (let start = job.checkpoint; start < parsed.length; start += CHUNK) {
        if (start > job.checkpoint) await this.principal(job); // revocation between chunks stops the job
        for (let i = start; i < Math.min(start + CHUNK, parsed.length); i++) {
          const p = parsed[i];
          if (p.errors.length) {
            results[i] = failed(p, i);
          } else if (unchanged(p, i)) {
            results[i] = { index: i, status: 'unchanged', id: p.id!, errors: [] };
          } else {
            try {
              const body = { ...p.data } as Record<string, unknown>;
              if (p.op === 'CREATE') {
                const e = await this.employees.create(user, { ...body, employeeCode: p.code } as never);
                codeToId.set(p.code.toLowerCase(), e.id);
                results[i] = { index: i, status: 'created', id: e.id, errors: [] };
              } else {
                if (Object.keys(body).length) await this.employees.update(user, p.id!, body as never);
                else await this.employees.get(user, p.id!); // scope check for manager/externalId-only rows
                results[i] = { index: i, status: 'updated', id: p.id!, errors: [] };
              }
            } catch (err) {
              results[i] = { index: i, status: 'failed', id: p.id ?? null, errors: [rowError(err)] };
            }
          }
        }
        const done = Math.min(start + CHUNK, parsed.length);
        await this.save(job.id, {
          checkpoint: done,
          progress: { processed: done, total: parsed.length },
          result: { rows: results } as unknown as Prisma.InputJsonValue,
          lockedUntil: new Date(Date.now() + LEASE_MS),
        });
      }

      // Managers and externalIds once everyone exists (a manager may be a later record). Idempotent on resume.
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const r = results[i];
        if (!r || r.status === 'failed' || r.status === 'unchanged') continue;
        const data: Prisma.EmployeeUpdateInput = {};
        if (p.managerCode !== undefined) {
          const managerId = p.managerCode === null ? null : codeToId.get(p.managerCode.toLowerCase());
          if (managerId === undefined) {
            results[i] = { ...r, status: 'failed', errors: [{ field: 'managerEmployeeCode', message: 'The manager could not be saved, so this was not set' }] };
            continue;
          }
          data.manager = managerId ? { connect: { id: managerId } } : { disconnect: true };
        }
        if (records[i].externalId !== undefined) data.externalId = records[i].externalId;
        if (!Object.keys(data).length) continue;
        try {
          await this.prisma.employee.update({ where: { id: r.id! }, data });
        } catch (err) {
          results[i] = { ...r, status: 'failed', errors: [rowError(err)] };
        }
      }
    });
    await this.finish(job, results, null);
  }

  private async finish(job: ApiJob, rows: RowResult[], error: { code: string; message: string } | null) {
    const summary = { created: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0 };
    for (const r of rows) summary[r.status]++;
    const ok = rows.length - summary.failed - summary.skipped;
    const status = error || ok === 0 ? 'FAILED' : summary.failed ? 'PARTIALLY_SUCCEEDED' : 'SUCCEEDED';
    const input = job.input as unknown as BulkInput;
    await runAsSystem(() =>
      this.audit.run({
        action: input.validateOnly ? 'EMPLOYEES_BULK_VALIDATED' : 'EMPLOYEES_BULK_UPSERT',
        targetType: 'ApiJob',
        targetId: job.id,
        actor: { type: 'api_key', userId: `apikey:${job.apiKeyId}` },
        tenantId: job.tenantId,
        payloadFrom: () => ({ summary, status }),
        run: (tx) =>
          tx.apiJob.update({
            where: { id: job.id },
            data: {
              status,
              error: error ?? Prisma.JsonNull,
              result: { summary, rows } as unknown as Prisma.InputJsonValue,
              progress: { processed: rows.length, total: rows.length },
              checkpoint: rows.length,
              completedAt: new Date(),
              lockedUntil: null,
            },
          }),
      }),
    );
  }
}
