import { Body, Controller, Get, Injectable, Logger, Module, Param, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { Allow, IsBase64, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RecomputeQueue } from '../attendance/recompute.service';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuditActor, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { addDays, dbDate, localYmd, ymdOf } from '../common/time';
import { IsYmd } from '../common/validators';
import { seedChecklist } from '../hr/checklists';
import { employmentTypesOf } from '../org/org';
import { saveSalary } from '../payroll/salary';
import { TerminalEnrollmentService } from '../terminals/services/terminal-enrollment.service';
import { TerminalsModule } from '../terminals/terminals.module';
import { UsersModule } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { coerceField, DATE_KEYS, DIRECTORY_KEYS, FIELD, isRealYmd, MOBILE_PUNCH, SENSITIVE_KEYS } from './fields';
import { buildTemplate, ImportMode, importColumns, parseImportRows, readWorkbook } from './import';
import { featuresOf, RequireFeature } from '../common/features';

export { isRealYmd };
/** Shape only here; the tenant's own list (Settings → employee categories) is checked in validateRefs. */
const EMPLOYMENT_TYPE = /^[A-Z0-9_]{1,20}$/;

/**
 * The directory fields (fields.ts) are whitelisted here and validated by
 * `directoryData` against the same registry the import uses, so the API and
 * the spreadsheet accept exactly the same values.
 */
export class DirectoryDto {
  [key: string]: unknown;
}
for (const key of DIRECTORY_KEYS) Allow()(DirectoryDto.prototype, key);

export class EmployeeDto extends DirectoryDto {
  @IsString() @MinLength(1) @MaxLength(40) employeeCode: string;
  @IsString() @MinLength(1) @MaxLength(120) fullName: string;
  @IsString() siteId: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() managerId?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(80) designation?: string | null;
  @IsOptional() @Matches(EMPLOYMENT_TYPE) employmentType?: string;
  @IsYmd() joinedOn: string;
  @IsOptional() @IsIn(MOBILE_PUNCH) mobilePunch?: (typeof MOBILE_PUNCH)[number];
  /** HR confirms the employee consented to face enrolment (§17). */
  @IsOptional() @IsBoolean() biometricConsent?: boolean;
  /** Schedule to start with; defaults to the tenant's default shift. */
  @IsOptional() @IsString() shiftId?: string;
}

export class UpdateEmployeeDto extends DirectoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) employeeCode?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() managerId?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(80) designation?: string | null;
  @IsOptional() @Matches(EMPLOYMENT_TYPE) employmentType?: string;
  @IsOptional() @IsYmd() joinedOn?: string;
  @IsOptional() @IsYmd() exitOn?: string | null;
  @IsOptional() @IsIn(MOBILE_PUNCH) mobilePunch?: (typeof MOBILE_PUNCH)[number];
  @IsOptional() @IsBoolean() biometricConsent?: boolean;
}

export class EmployeeQuery {
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() managerId?: string;
  @IsOptional() @IsIn(['ACTIVE', 'EXITED']) status?: string;
  /** true = interns only, false = everyone but interns. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() intern?: boolean;
  /** Name, code or email contains. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) size?: number;
}

export class ImportDto {
  /**
   * CSV with a header row naming any columns of GET /employees/import/columns
   * (labels and common spellings are recognised). An .xlsx goes through
   * POST /employees/import/read first.
   */
  @IsString() @MaxLength(5_000_000) csv: string;
  /** CREATE (default): new employees only. UPSERT: update existing codes (blank keeps, "-" clears), add new ones. */
  @IsOptional() @IsIn(['CREATE', 'UPSERT']) mode?: ImportMode;
  /** New employees join this site (the import wizard's location step); overrides siteName for them. */
  @IsOptional() @IsString() siteId?: string;
  /** false (default) = validate and preview only. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() commit?: boolean;
  @IsOptional() @IsBoolean() biometricConsent?: boolean;
}

export class ReadWorkbookDto {
  /** The .xlsx, base64. */
  @IsBase64() @MaxLength(14_000_000) fileBase64: string;
}

export class TemplateQuery {
  @IsOptional() @IsString() siteId?: string;
  /** true = the workbook filled with current employees, for Update mode. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() prefill?: boolean;
}

/** Registry-validated directory fields of a create/update body → Prisma data. Throws 400 naming the field. */
export function directoryData(dto: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const key of DIRECTORY_KEYS) {
    const v = dto[key];
    if (v === undefined) continue;
    if (v === null || v === '') {
      data[key] = null;
      continue;
    }
    const out = coerceField(FIELD[key], String(v));
    if ('error' in out) throw new AppError(400, 'INVALID_FIELD', out.error, [{ field: key, message: out.error }]);
    data[key] = out.value !== null && DATE_KEYS.includes(key) ? dbDate(out.value as string) : out.value;
  }
  return data;
}

const baseOf = (dto: Record<string, unknown>) => Object.fromEntries(Object.entries(dto).filter(([k]) => !DIRECTORY_KEYS.includes(k)));

export class OffboardDto {
  @IsYmd() exitOn: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** RFC 4180-ish CSV parse (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly scope: ScopeService,
    private readonly queue: RecomputeQueue,
    private readonly users: UsersService,
    private readonly enrollment: TerminalEnrollmentService,
  ) {}

  private async validateRefs(user: AuthUser, d: { siteId?: string; departmentId?: string | null; managerId?: string | null; employmentType?: string }, selfId?: string) {
    const tenantId = user.tenantId;
    // A site-restricted user cannot place people at sites outside their own.
    if (d.siteId && user.siteIds.length && !user.siteIds.includes(d.siteId)) throw new AppError(403, 'SITE_FORBIDDEN', 'That site is outside your access');
    if (d.employmentType) {
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const types = employmentTypesOf(tenant.settings).map((t) => t.code);
      if (!types.includes(d.employmentType)) throw new AppError(400, 'UNKNOWN_EMPLOYMENT_TYPE', `employmentType must be one of ${types.join(', ')}`);
    }
    if (d.siteId && !(await this.prisma.site.count({ where: { id: d.siteId, tenantId } }))) throw new AppError(400, 'SITE_NOT_FOUND', 'Unknown site');
    if (d.departmentId && !(await this.prisma.department.count({ where: { id: d.departmentId, tenantId } }))) {
      throw new AppError(400, 'DEPARTMENT_NOT_FOUND', 'Unknown department');
    }
    if (d.managerId) {
      if (d.managerId === selfId) throw new AppError(400, 'SELF_MANAGER', 'An employee cannot manage themselves');
      if (!(await this.prisma.employee.count({ where: { id: d.managerId, tenantId } }))) throw new AppError(400, 'MANAGER_NOT_FOUND', 'Unknown manager');
    }
  }

  async create(user: AuthUser, dto: EmployeeDto, actor: AuditActor = actorOf(user)) {
    await this.validateRefs(user, dto);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    const shift = dto.shiftId
      ? await this.prisma.shift.findFirst({ where: { id: dto.shiftId, tenantId: user.tenantId } })
      : await this.prisma.shift.findFirst({ where: { tenantId: user.tenantId, isDefault: true, active: true } });
    if (dto.shiftId && !shift) throw new AppError(400, 'UNKNOWN_SHIFT', 'Unknown shift');
    const { biometricConsent, shiftId: _s, ...data } = baseOf(dto) as EmployeeDto;
    const directory = directoryData(dto);

    const employee = await this.audit.run({
      action: 'EMPLOYEE_CREATED',
      targetType: 'Employee',
      actor,
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeCode: dto.employeeCode, fullName: dto.fullName, siteId: dto.siteId }),
      run: async (tx) => {
        const e = await tx.employee.create({
          data: {
            ...(data as any),
            ...directory,
            employmentType: data.employmentType ?? employmentTypesOf(tenant.settings)[0].code,
            email: data.email?.toLowerCase() ?? null,
            tenantId: user.tenantId,
            joinedOn: dbDate(dto.joinedOn),
            ...(biometricConsent ? { biometricConsentAt: new Date(), biometricConsentBy: user.sub } : {}),
          },
        });
        // Everyone starts on a schedule, so the engine always has something to judge against.
        if (shift) {
          await tx.employeeSchedule.create({
            data: {
              tenantId: user.tenantId,
              employeeId: e.id,
              effectiveFrom: dbDate(dto.joinedOn),
              shiftId: shift.id,
              weeklyOffs: ((tenant.settings as any)?.defaultWeeklyOffs as number[]) ?? [0],
              createdBy: user.sub,
            },
          });
        }
        await seedChecklist(tx, e, 'ONBOARDING', tenant.settings);
        return e;
      },
    });
    const today = localYmd(new Date(), 'UTC');
    await this.queue.bulk({ tenantId: user.tenantId, employeeIds: [employee.id], from: addDays(today, -1), to: addDays(today, 14), rematerialise: true });
    return this.present(employee);
  }

  /**
   * Dates as YYYY-MM-DD. With a viewer, PAN/UAN/ESIC/bank are left out unless
   * they are HR/admin or the employee themself (a manager sees the rest).
   */
  present(e: Employee & Record<string, any>, viewer?: AuthUser) {
    const out: Record<string, any> = { ...e, joinedOn: ymdOf(e.joinedOn), exitOn: e.exitOn ? ymdOf(e.exitOn) : null };
    for (const k of DATE_KEYS) if (out[k] instanceof Date) out[k] = ymdOf(out[k]);
    if (viewer && !isHrOrAdmin(viewer) && viewer.employeeId !== e.id) for (const k of SENSITIVE_KEYS) delete out[k];
    return out;
  }

  async list(user: AuthUser, q: EmployeeQuery) {
    const page = q.page ?? 1;
    const size = q.size ?? 50;
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        await this.scope.employeeWhere(user),
        q.siteId ? { siteId: q.siteId } : {},
        q.departmentId ? { departmentId: q.departmentId } : {},
        q.managerId ? { managerId: q.managerId } : {},
        q.projectId ? { projects: { some: { projectId: q.projectId } } } : {},
        { status: q.status ?? 'ACTIVE' },
        q.intern === undefined ? {} : q.intern ? { employmentType: 'INTERN' } : { employmentType: { not: 'INTERN' } },
        q.q
          ? {
              OR: [
                { fullName: { contains: q.q, mode: 'insensitive' } },
                { employeeCode: { contains: q.q, mode: 'insensitive' } },
                { email: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [items, total] = await this.prisma.$transaction((tx) => Promise.all([
      tx.employee.findMany({
        where,
        include: { site: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, manager: { select: { id: true, fullName: true } } },
        orderBy: { fullName: 'asc' },
        skip: (page - 1) * size,
        take: size,
      }),
      tx.employee.count({ where }),
    ]));
    return { items: items.map((e) => this.present(e, user)), total, page, size };
  }

  async get(user: AuthUser, id: string) {
    // The scope check and the load in one query; 404 (not 403) outside the caller's scope, as assertEmployee.
    const e = await this.prisma.employee.findFirst({
      where: { AND: [await this.scope.employeeWhere(user), { id }] },
      include: {
        site: true,
        department: true,
        manager: { select: { id: true, fullName: true, employeeCode: true } },
        projects: { include: { project: { select: { id: true, name: true } } } },
      },
    });
    if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    const [profile, schedules, slots, template] = await this.prisma.$transaction((tx) => Promise.all([
      e.userId ? tx.userProfile.findUnique({ where: { userId: e.userId } }) : null,
      tx.employeeSchedule.findMany({ where: { employeeId: id }, orderBy: { effectiveFrom: 'desc' }, take: 5 }),
      tx.terminalUser.findMany({ where: { subjectId: id }, include: { device: { select: { id: true, name: true, serialNo: true, gateName: true } } } }),
      tx.terminalFaceTemplate.findFirst({ where: { subjectId: id, status: 'active' }, select: { updatedAt: true, sourceDeviceId: true } }),
    ]));
    return {
      ...this.present(e, user),
      login: profile ? { userId: profile.userId, role: profile.role, status: profile.status, mustChangePassword: profile.mustChangePassword } : null,
      schedules: schedules.map((s) => ({ ...s, effectiveFrom: ymdOf(s.effectiveFrom), effectiveTo: s.effectiveTo ? ymdOf(s.effectiveTo) : null, anchorDate: s.anchorDate ? ymdOf(s.anchorDate) : null })),
      faces: { template, terminals: slots },
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateEmployeeDto) {
    const before = await this.scope.assertOther(user, id);
    await this.validateRefs(user, dto, id);
    const { biometricConsent, joinedOn, exitOn, ...rest } = baseOf(dto) as UpdateEmployeeDto;
    const directory = directoryData(dto);
    const after = await this.audit.run({
      action: 'EMPLOYEE_UPDATED',
      targetType: 'Employee',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.employee.update({
          where: { id },
          data: {
            ...(rest as any),
            ...directory,
            ...(rest.email !== undefined ? { email: rest.email?.toLowerCase() ?? null } : {}),
            ...(joinedOn ? { joinedOn: dbDate(joinedOn) } : {}),
            ...(exitOn !== undefined ? { exitOn: exitOn ? dbDate(exitOn) : null } : {}),
            ...(biometricConsent === true && !before.biometricConsentAt ? { biometricConsentAt: new Date(), biometricConsentBy: user.sub } : {}),
            ...(biometricConsent === false ? { biometricConsentAt: null, biometricConsentBy: null } : {}),
          },
        }),
    });

    // Validity window on every terminal holding a slot (§4.3). Best effort; offline devices catch up on re-enrolment.
    if (joinedOn || exitOn !== undefined) {
      const slots = await this.prisma.terminalUser.findMany({ where: { subjectId: id, releasedAt: null } });
      for (const s of slots) await this.enrollment.syncUserPeriod(s.deviceId, after).catch(() => false);
    }
    if (dto.siteId || dto.departmentId !== undefined || joinedOn || exitOn !== undefined || dto.mobilePunch) {
      const today = localYmd(new Date(), 'UTC');
      await this.queue.bulk({ tenantId: user.tenantId, employeeIds: [id], from: addDays(today, -1), to: addDays(today, 14), rematerialise: true });
    }
    return this.present(after);
  }

  /**
   * Validate → preview → commit. Rows reference sites/departments/structures
   * by name and managers by code, so HR can fill the sheet without looking up
   * ids. CREATE adds new employees; UPSERT also updates existing ones (blank
   * cell = keep, "-" = clear) and sets salaries.
   */
  async import(user: AuthUser, dto: ImportDto) {
    const rows = parseCsv(dto.csv);
    if (rows.length < 2) throw new AppError(400, 'EMPTY_CSV', 'The file needs a header row and at least one employee');
    if (rows.length > 5001) throw new AppError(400, 'CSV_TOO_LARGE', 'At most 5000 employees per import');
    const mode = dto.mode ?? 'CREATE';
    const [sites, departments, existing, tenant, structures, salaries] = await Promise.all([
      this.prisma.site.findMany({ where: { tenantId: user.tenantId } }),
      this.prisma.department.findMany({ where: { tenantId: user.tenantId } }),
      this.prisma.employee.findMany({ where: { tenantId: user.tenantId }, select: { id: true, employeeCode: true } }),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { settings: true } }),
      this.prisma.salaryStructure.findMany({ where: { tenantId: user.tenantId, active: true }, select: { id: true, name: true } }),
      this.prisma.employeeSalary.findMany({ where: { tenantId: user.tenantId }, orderBy: { effectiveFrom: 'desc' }, select: { employeeId: true, structureId: true } }),
    ]);
    if (dto.siteId && !sites.some((s) => s.id === dto.siteId)) throw new AppError(400, 'SITE_NOT_FOUND', 'Unknown site');
    const currentStructure = new Map<string, string>();
    for (const s of salaries) if (!currentStructure.has(s.employeeId)) currentStructure.set(s.employeeId, s.structureId);
    const codes = new Map(existing.map((e) => [e.employeeCode.toLowerCase(), { id: e.id, structureId: currentStructure.get(e.id) ?? null }]));

    const { parsed, missing, ignored } = parseImportRows(rows, {
      mode,
      fixedSiteId: dto.siteId,
      sites,
      departments,
      existing: codes,
      categories: employmentTypesOf(tenant.settings),
      structures,
      today: localYmd(new Date(), (tenant.settings as any)?.timezone || 'Asia/Kolkata'),
      noSalary: !featuresOf(tenant.settings).payroll,
    });
    if (missing.length) throw new AppError(400, 'MISSING_COLUMN', `Missing column${missing.length > 1 ? 's' : ''} ${missing.map((k) => FIELD[k].label).join(', ')}`);
    const invalid = parsed.filter((p) => p.errors.length);
    const preview = {
      mode,
      total: parsed.length,
      valid: parsed.length - invalid.length,
      invalid: invalid.length,
      creates: parsed.filter((p) => p.op === 'CREATE').length,
      updates: parsed.filter((p) => p.op === 'UPDATE').length,
      ignoredColumns: ignored,
      errors: invalid.map((p) => ({ line: p.line, errors: p.errors })),
    };
    if (!dto.commit) {
      return { committed: false, ...preview, sample: parsed.slice(0, 20).map((p) => ({ line: p.line, op: p.op, employeeCode: p.code, ...p.data, managerCode: p.managerCode })) };
    }
    if (invalid.length) throw new AppError(400, 'IMPORT_INVALID', 'Fix the invalid rows before committing', preview.errors);

    const created: string[] = [];
    const updated: string[] = [];
    for (const p of parsed) {
      const body = { ...p.data, employeeCode: p.code } as Record<string, any>;
      if (p.op === 'CREATE') {
        const e = await this.create(user, { ...body, biometricConsent: dto.biometricConsent } as EmployeeDto);
        codes.set(p.code.toLowerCase(), { id: e.id, structureId: null });
        created.push(e.id);
      } else {
        // Salary / manager-only rows skip update(), so check scope here too.
        await this.scope.assertOther(user, p.id!);
        const { employeeCode: _c, ...changes } = body;
        if (Object.keys(changes).length) await this.update(user, p.id!, changes as UpdateEmployeeDto);
        updated.push(p.id!);
      }
    }
    // Managers and salaries after everyone exists: a manager may be a row further down.
    for (const p of parsed) {
      const id = codes.get(p.code.toLowerCase())!.id;
      if (p.managerCode !== undefined) {
        await this.prisma.employee.update({ where: { id }, data: { managerId: p.managerCode === null ? null : codes.get(p.managerCode.toLowerCase())!.id } });
      }
      if (p.salary) {
        const salary = p.salary;
        await this.audit.run({
          action: 'SALARY_SET',
          targetType: 'Employee',
          targetId: id,
          actor: actorOf(user),
          tenantId: user.tenantId,
          payloadFrom: () => ({ ...salary, source: 'import' }),
          run: (tx) => saveSalary(tx, { tenantId: user.tenantId, employeeId: id, createdBy: user.sub, ...salary }),
        });
      }
    }
    await this.audit.log({
      tenantId: user.tenantId,
      actor: actorOf(user),
      action: 'EMPLOYEES_IMPORTED',
      targetType: 'Employee',
      payload: { mode, created: created.length, updated: updated.length },
    });
    return { committed: true, ...preview, createdIds: created, updatedIds: updated };
  }

  /** The styled .xlsx: dropdowns from this tenant's sites, departments, categories and structures. */
  /** The import registry (salary columns only with the payroll module). */
  async importColumns(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { settings: true } });
    return importColumns(!featuresOf(tenant.settings).payroll);
  }

  async template(user: AuthUser, q: TemplateQuery) {
    const [tenant, sites, departments, structures, employees] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
      this.prisma.site.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } }),
      this.prisma.department.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } }),
      this.prisma.salaryStructure.findMany({ where: { tenantId: user.tenantId, active: true }, orderBy: { name: 'asc' } }),
      this.prisma.employee.findMany({
        where: { AND: [await this.scope.employeeWhere(user), { status: 'ACTIVE' }, q.siteId ? { siteId: q.siteId } : {}] },
        include: { site: true, department: true, manager: { select: { employeeCode: true } }, salaries: { orderBy: { effectiveFrom: 'desc' }, take: 1, include: { structure: true } } },
        orderBy: { employeeCode: 'asc' },
      }),
    ]);
    const tz = (tenant.settings as any)?.timezone || 'Asia/Kolkata';
    const rows = q.prefill
      ? employees.map((e) => {
          const p = this.present(e as any);
          const salary = e.salaries[0];
          return {
            ...p,
            siteName: e.site.name,
            departmentName: e.department?.name ?? null,
            managerCode: e.manager?.employeeCode ?? null,
            salaryStructure: salary?.structure.name ?? null,
            monthlyGross: salary ? salary.monthlyGross / 100 : null,
          } as Record<string, string | number | null>;
        })
      : undefined;
    const buf = await buildTemplate({
      orgName: tenant.name,
      sites: sites.map((s) => s.name),
      departments: departments.map((d) => d.name),
      categories: employmentTypesOf(tenant.settings),
      structures: structures.map((s) => s.name),
      managerCodes: employees.map((e) => e.employeeCode),
      rows,
      hideSite: Boolean(q.siteId) && !q.prefill,
      hideSalary: !featuresOf(tenant.settings).payroll,
      generatedOn: localYmd(new Date(), tz),
    });
    const name = `${tenant.slug}-employees-${q.prefill ? 'update' : 'template'}.xlsx`;
    if (q.prefill) await this.audit.log({ tenantId: user.tenantId, actor: actorOf(user), action: 'EMPLOYEES_EXPORTED', targetType: 'Employee', payload: { count: employees.length } });
    return new StreamableFile(buf, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: `attachment; filename="${name}"` });
  }

  async readWorkbook(dto: ReadWorkbookDto) {
    const buf = Buffer.from(dto.fileBase64, 'base64');
    // An .xlsx is a zip, which starts "PK\x03\x04".
    if (buf.subarray(0, 4).toString('hex') !== '504b0304') throw new AppError(400, 'NOT_XLSX', 'The file is not an Excel workbook (.xlsx)');
    let rows: string[][];
    try {
      rows = await readWorkbook(buf);
    } catch {
      throw new AppError(400, 'NOT_XLSX', 'The workbook could not be read — save it as .xlsx and try again');
    }
    if (!rows.length) throw new AppError(400, 'NO_HEADER', 'No sheet has an "Employee code" header row');
    return { rows };
  }

  /** Everyone active in the tenant (site-scoped logins see their sites): names and reporting lines only. */
  async orgChart(user: AuthUser) {
    const people = await this.prisma.employee.findMany({
      where: { tenantId: user.tenantId, status: 'ACTIVE', ...(user.siteIds.length ? { siteId: { in: user.siteIds } } : {}) },
      select: { id: true, employeeCode: true, fullName: true, designation: true, managerId: true, department: { select: { name: true } }, site: { select: { name: true } } },
      orderBy: { fullName: 'asc' },
    });
    return people.map((p) => ({ id: p.id, employeeCode: p.employeeCode, fullName: p.fullName, designation: p.designation, managerId: p.managerId, department: p.department?.name ?? null, site: p.site.name }));
  }

  /**
   * Exit (§4.3, §13.2): exit date, device cleanup on every terminal holding a
   * slot (never aborting the batch; offline ones retried hourly), templates
   * deleted, login removed so the email is free again.
   */
  async offboard(user: AuthUser, id: string, dto: OffboardDto) {
    const employee = await this.scope.assertOther(user, id);
    if (employee.status === 'EXITED') throw new AppError(409, 'ALREADY_EXITED', 'Employee has already exited');
    if (dto.exitOn < ymdOf(employee.joinedOn)) throw new AppError(400, 'BAD_EXIT_DATE', 'Exit date is before the joining date');
    const actor = actorOf(user);

    const exited = await this.audit.run({
      action: 'EMPLOYEE_OFFBOARDED',
      targetType: 'Employee',
      targetId: id,
      actor,
      tenantId: user.tenantId,
      payloadFrom: () => ({ exitOn: dto.exitOn, reason: dto.reason ?? null }),
      run: async (tx) => {
        await tx.attendanceDay.deleteMany({ where: { employeeId: id, workDate: { gt: dbDate(dto.exitOn) } } });
        await tx.terminalFaceTemplate.deleteMany({ where: { subjectId: id } });
        await tx.leaveRequest.updateMany({ where: { employeeId: id, status: 'PENDING' }, data: { status: 'CANCELLED', decisionNote: 'Employee exited' } });
        await tx.remoteWorkRequest.updateMany({ where: { employeeId: id, status: 'PENDING' }, data: { status: 'CANCELLED', decisionNote: 'Employee exited' } });
        const exitedRow = await tx.employee.update({ where: { id }, data: { exitOn: dbDate(dto.exitOn), status: 'EXITED' } });
        await seedChecklist(tx, exitedRow, 'OFFBOARDING');
        return exitedRow;
      },
    });

    const devices = await this.offboardDevices(id, actor);
    if (employee.userId) await this.users.removeLogin(user.tenantId, employee.userId, actor);
    return { employee: this.present(exited), devices, loginRemoved: Boolean(employee.userId) };
  }

  /** Also used by the hourly terminal-offboard-retry job. */
  async offboardDevices(employeeId: string, actor: AuditActor) {
    const slots = await this.prisma.terminalUser.findMany({
      where: { subjectId: employeeId, releasedAt: null },
      include: { device: { select: { serialNo: true } } },
    });
    const results: Array<{ deviceId: string; serialNo: string; status: string; error?: string }> = [];
    for (const s of slots) {
      try {
        results.push({ deviceId: s.deviceId, serialNo: s.device.serialNo, status: await this.enrollment.offboard(s.deviceId, employeeId, actor) });
      } catch (err) {
        results.push({ deviceId: s.deviceId, serialNo: s.device.serialNo, status: 'failed', error: (err as Error).message });
      }
    }
    return results;
  }

  /** Hourly: retry DeleteUser on terminals that were offline at exit. */
  async retryPendingOffboarding() {
    return runAsSystem(async () => {
      const pending = await this.prisma.terminalUser.findMany({ where: { releasedAt: null }, select: { subjectId: true } });
      const exited = await this.prisma.employee.findMany({
        where: { id: { in: [...new Set(pending.map((p) => p.subjectId))] }, status: 'EXITED' },
        select: { id: true },
      });
      for (const e of exited) await this.offboardDevices(e.id, { type: 'system' });
      return exited.length;
    });
  }
}

@ApiTags('employees')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: EmployeeQuery) {
    return this.employees.list(user, q);
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: EmployeeDto) {
    return this.employees.create(user, dto);
  }

  @Post('import')
  @Roles('ADMIN', 'HR')
  import(@CurrentUser() user: AuthUser, @Body() dto: ImportDto) {
    return this.employees.import(user, dto);
  }

  /** The import registry: every column, its rule, example and accepted header spellings. */
  @Get('import/columns')
  @Roles('ADMIN', 'HR')
  importColumns(@CurrentUser() user: AuthUser) {
    return this.employees.importColumns(user);
  }

  @Get('import/template.xlsx')
  @Roles('ADMIN', 'HR')
  template(@CurrentUser() user: AuthUser, @Query() q: TemplateQuery) {
    return this.employees.template(user, q);
  }

  /** .xlsx → rows (header first), for the wizard to map and check like a CSV. */
  @Post('import/read')
  @Roles('ADMIN', 'HR')
  read(@Body() dto: ReadWorkbookDto) {
    return this.employees.readWorkbook(dto);
  }

  @Get('org-chart')
  @RequireFeature('hr')
  orgChart(@CurrentUser() user: AuthUser) {
    return this.employees.orgChart(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.employees.get(user, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(user, id, dto);
  }

  @Post(':id/offboard')
  @Roles('ADMIN', 'HR')
  offboard(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: OffboardDto) {
    return this.employees.offboard(user, id, dto);
  }
}

@Module({
  imports: [TerminalsModule, UsersModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
