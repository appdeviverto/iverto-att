import { mergeTenantSettings, RequireFeature } from '../common/features';
import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { BATCH_TIMEOUT_MS, PrismaService } from '../common/prisma.service';
import { dbDate, formatLocal, localYmd, ymdOf, Ymd } from '../common/time';
import { IsMonth, IsYmd } from '../common/validators';
import { brandOf, renderBranded, rupees, rupeesInWords } from '../hr/pdf-docs';
import { NotificationsService } from '../notifications/notifications';
import { toCsv } from '../reports/csv';
import {
  Component,
  computePayslip,
  DayInput,
  DEFAULT_STRUCTURE,
  Line,
  nextPeriod,
  PayableDays,
  payableDays,
  PayrollSettings,
  payrollSettingsOf,
} from './engine';
import { isLocked } from './lock';
import { saveSalary } from './salary';

// ── DTOs ────────────────────────────────────────────────────────────────────

class PtSlabDto {
  @Type(() => Number) @IsNumber() @Min(0) min: number;
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) febAmount?: number;
}

export class PayrollSettingsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(28) cycleStartDay?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31) payDay?: number;
  @IsOptional() @IsIn(['APPROVED', 'PAID', 'MANUAL']) lockOn?: PayrollSettings['lockOn'];
  @IsOptional() @IsIn(['BLOCK', 'SNAPSHOT_ONLY']) lockMode?: PayrollSettings['lockMode'];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(31) lockGraceDays?: number;
  @IsOptional() @IsBoolean() otEnabled?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(4) otMultiplier?: number;
  @IsOptional() @IsIn(['GROSS', 'BASIC']) otBase?: PayrollSettings['otBase'];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(24) standardHoursPerDay?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) pfRate?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) pfWageCap?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) esiEmployeeRate?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) esiEmployerRate?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) esiThreshold?: number;
  /** { "KA": [{ min, amount, febAmount? }] } — replaces the whole table. */
  @IsOptional() @IsObject() ptSlabs?: Record<string, PtSlabDto[]>;
  @IsOptional() @IsString() @MaxLength(10) defaultPtState?: string | null;
}

class ComponentDto implements Component {
  @Matches(/^[A-Z][A-Z0-9_]{0,19}$/, { message: 'code must be 1–20 capitals, digits or _' }) code: string;
  @IsString() @MinLength(1) @MaxLength(60) name: string;
  @IsIn(['EARNING', 'DEDUCTION']) kind: 'EARNING' | 'DEDUCTION';
  @IsIn(['FIXED', 'PCT_GROSS', 'PCT_BASIC', 'BALANCE']) calc: Component['calc'];
  @Type(() => Number) @IsNumber() @Min(0) value: number;
  @IsBoolean() prorate: boolean;
}

export class StructureDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ComponentDto) components: ComponentDto[];
  @IsOptional() @IsBoolean() active?: boolean;
}

export class SalaryDto {
  @IsYmd() effectiveFrom: string;
  @IsString() structureId: string;
  /** Rupees per month. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) monthlyGross: number;
  /** { componentCode: rupees per month } */
  @IsOptional() @IsObject() overrides?: Record<string, number>;
  @IsOptional() @IsBoolean() pf?: boolean;
  @IsOptional() @IsBoolean() esi?: boolean;
  @IsOptional() @IsBoolean() pt?: boolean;
  @IsOptional() @IsString() @MaxLength(10) ptState?: string | null;
}

export class AdjustmentDto {
  /** One employee… */
  @IsOptional() @IsString() employeeId?: string;
  /** …or several at once (same month, type, amount and note for each). */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @IsString({ each: true }) employeeIds?: string[];
  @IsMonth() month: string;
  @IsIn(['EARNING', 'DEDUCTION']) kind: 'EARNING' | 'DEDUCTION';
  @IsIn(['BONUS', 'INCENTIVE', 'ARREARS', 'ADVANCE', 'OTHER']) code: string;
  /** Rupees. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99_999_999) amount: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class LoanDto {
  @IsString() employeeId: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(99_999_999) principal: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(99_999_999) emi: number;
  /** First month the EMI is deducted. */
  @IsMonth() startMonth: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class MonthQuery {
  @IsOptional() @IsMonth() month?: string;
  @IsOptional() @IsString() employeeId?: string;
}

export class RunDto {
  @IsMonth() month: string;
  /** Run even though the period has not ended or has unfinalised attendance days. */
  @IsOptional() @IsBoolean() force?: boolean;
}

// ── Service ─────────────────────────────────────────────────────────────────

const paise = (rupees: number) => Math.round(rupees * 100);
const monthName = (month: string) => formatLocal(new Date(`${month}-15T00:00:00Z`), 'UTC', 'MMMM yyyy');

type RunRow = Prisma.PayrollRunGetPayload<{}>;

/**
 * Payroll: settings, salary structures, effective-dated salaries, one-off
 * adjustments, loans, and the monthly run (DRAFT → APPROVED → PAID). A run
 * freezes its pay period and every payslip keeps the payable days it was
 * computed from; the maths is engine.ts.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly notifications: NotificationsService,
  ) {}

  private async tenant(tenantId: string) {
    return this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  }

  private today(tenant: { settings: unknown }) {
    return localYmd(new Date(), (tenant.settings as any)?.timezone || 'Asia/Kolkata');
  }

  // Settings

  async settings(user: AuthUser) {
    return payrollSettingsOf((await this.tenant(user.tenantId)).settings);
  }

  async saveSettings(user: AuthUser, dto: PayrollSettingsDto) {
    const t = await this.audit.run({
      action: 'PAYROLL_SETTINGS_UPDATED',
      targetType: 'Tenant',
      targetId: user.tenantId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => mergeTenantSettings(tx, user.tenantId, { ...dto }, 'payroll'),
    });
    return payrollSettingsOf(t.settings);
  }

  // Structures

  /** Every org starts with a "Standard" structure (Basic 50% / HRA 50% of Basic / special allowance). */
  async structures(user: AuthUser) {
    if (!(await this.prisma.salaryStructure.count({ where: { tenantId: user.tenantId } }))) {
      await this.prisma.salaryStructure.create({ data: { tenantId: user.tenantId, name: 'Standard', components: DEFAULT_STRUCTURE as unknown as Prisma.InputJsonValue } });
    }
    return this.prisma.salaryStructure.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' }, include: { _count: { select: { salaries: true } } } });
  }

  private checkComponents(components: Component[]) {
    const codes = new Set(components.map((c) => c.code));
    if (codes.size !== components.length) throw new AppError(400, 'DUPLICATE_COMPONENT', 'Component codes must be unique');
    if (components.filter((c) => c.calc === 'BALANCE').length > 1) throw new AppError(400, 'TWO_BALANCES', 'Only one component can take the balance');
    if (components.some((c) => c.calc === 'BALANCE' && c.kind !== 'EARNING')) throw new AppError(400, 'BAD_BALANCE', 'The balancing component must be an earning');
    if (components.some((c) => c.calc === 'PCT_BASIC') && !codes.has('BASIC')) throw new AppError(400, 'NO_BASIC', '% of Basic needs a component with code BASIC');
    const pctGross = components.filter((c) => c.kind === 'EARNING' && c.calc === 'PCT_GROSS').reduce((s, c) => s + c.value, 0);
    if (pctGross > 100) throw new AppError(400, 'OVER_100', 'Earnings as % of gross add up to more than 100%');
  }

  async saveStructure(user: AuthUser, dto: StructureDto, id?: string) {
    this.checkComponents(dto.components);
    if (id && !(await this.prisma.salaryStructure.count({ where: { id, tenantId: user.tenantId } }))) throw new AppError(404, 'NOT_FOUND', 'Structure not found');
    const clash = await this.prisma.salaryStructure.findFirst({ where: { tenantId: user.tenantId, name: dto.name, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw new AppError(409, 'DUPLICATE_NAME', `A structure named ${dto.name} exists`);
    const data = { name: dto.name, components: dto.components as unknown as Prisma.InputJsonValue, ...(dto.active !== undefined ? { active: dto.active } : {}) };
    return this.audit.run({
      action: id ? 'SALARY_STRUCTURE_UPDATED' : 'SALARY_STRUCTURE_CREATED',
      targetType: 'SalaryStructure',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => (id ? tx.salaryStructure.update({ where: { id }, data }) : tx.salaryStructure.create({ data: { ...data, tenantId: user.tenantId } })),
    });
  }

  // Salaries

  /** HR/admin, or the employee themself. */
  private async assertPayAccess(user: AuthUser, employeeId: string) {
    if (user.employeeId === employeeId) return this.scope.self(user);
    if (!isHrOrAdmin(user)) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    return this.scope.assertEmployee(user, employeeId);
  }

  async salaries(user: AuthUser, employeeId: string) {
    await this.assertPayAccess(user, employeeId);
    const rows = await this.prisma.employeeSalary.findMany({ where: { employeeId }, include: { structure: { select: { id: true, name: true } } }, orderBy: { effectiveFrom: 'desc' } });
    return rows.map((s) => ({
      ...s,
      effectiveFrom: ymdOf(s.effectiveFrom),
      monthlyGross: s.monthlyGross / 100,
      overrides: Object.fromEntries(Object.entries(s.overrides as Record<string, number>).map(([k, v]) => [k, v / 100])),
    }));
  }

  async setSalary(user: AuthUser, employeeId: string, dto: SalaryDto) {
    const e = await this.scope.assertOther(user, employeeId);
    if (!(await this.prisma.salaryStructure.count({ where: { id: dto.structureId, tenantId: user.tenantId } }))) throw new AppError(400, 'UNKNOWN_STRUCTURE', 'Unknown salary structure');
    for (const v of Object.values(dto.overrides ?? {})) if (typeof v !== 'number' || v < 0) throw new AppError(400, 'BAD_OVERRIDE', 'Overrides must be rupee amounts');
    await this.audit.run({
      action: 'SALARY_SET',
      targetType: 'Employee',
      targetId: employeeId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        saveSalary(tx, {
          tenantId: e.tenantId,
          employeeId,
          effectiveFrom: dto.effectiveFrom,
          structureId: dto.structureId,
          monthlyGross: paise(dto.monthlyGross),
          overrides: dto.overrides ? Object.fromEntries(Object.entries(dto.overrides).map(([k, v]) => [k, paise(v)])) : undefined,
          pf: dto.pf,
          esi: dto.esi,
          pt: dto.pt,
          ptState: dto.ptState,
          createdBy: user.sub,
        }),
    });
    return this.salaries(user, employeeId);
  }

  // Adjustments & loans

  async adjustments(user: AuthUser, q: MonthQuery) {
    const rows = await this.prisma.payrollAdjustment.findMany({
      where: { tenantId: user.tenantId, ...(q.month ? { month: q.month } : {}), ...(q.employeeId ? { employeeId: q.employeeId } : {}) },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
    return rows.map((a) => ({ ...a, amount: a.amount / 100, consumed: Boolean(a.payslipId) }));
  }

  /** One adjustment per employee given (employeeId or employeeIds), all in one transaction. Returns the created rows. */
  async addAdjustment(user: AuthUser, dto: AdjustmentDto) {
    const ids = [...new Set([...(dto.employeeIds ?? []), ...(dto.employeeId ? [dto.employeeId] : [])])];
    if (!ids.length) throw new AppError(400, 'NO_EMPLOYEES', 'Choose at least one employee');
    this.scope.assertNotSelf(user, ids);
    const inScope = await this.prisma.employee.count({ where: { AND: [await this.scope.employeeWhere(user), { id: { in: ids } }] } });
    if (inScope !== ids.length) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    const run = await this.prisma.payrollRun.findUnique({ where: { tenantId_month: { tenantId: user.tenantId, month: dto.month } } });
    if (run && run.status !== 'DRAFT') throw new AppError(409, 'RUN_CLOSED', `Payroll for ${dto.month} is ${run.status.toLowerCase()}; add it to a later month`);
    const { employeeId: _one, employeeIds: _many, ...rest } = dto;
    return this.audit.run({
      action: 'PAYROLL_ADJUSTMENT_ADDED',
      targetType: 'Employee',
      targetId: ids.length === 1 ? ids[0] : undefined,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...rest, employeeIds: ids }),
      run: (tx) =>
        Promise.all(ids.map((employeeId) => tx.payrollAdjustment.create({ data: { ...rest, employeeId, amount: paise(rest.amount), tenantId: user.tenantId, createdBy: user.sub } }))),
    });
  }

  async removeAdjustment(user: AuthUser, id: string) {
    const a = await this.prisma.payrollAdjustment.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Adjustment not found');
    if (a.payslipId) throw new AppError(409, 'CONSUMED', 'Already paid in an approved run');
    await this.audit.run({
      action: 'PAYROLL_ADJUSTMENT_DELETED',
      targetType: 'Employee',
      targetId: a.employeeId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: a.month, code: a.code, amount: a.amount }),
      run: (tx) => tx.payrollAdjustment.delete({ where: { id } }),
    });
    return { deleted: true };
  }

  /** Recovered so far per loan, from payslips of approved/paid runs. */
  private async recovered(loanIds: string[]) {
    const out = new Map<string, number>();
    if (!loanIds.length) return out;
    const slips = await this.prisma.payslip.findMany({
      where: { run: { status: { not: 'DRAFT' } }, employee: { loans: { some: { id: { in: loanIds } } } } },
      select: { lines: true },
    });
    for (const s of slips) for (const l of s.lines as unknown as Line[]) if (l.code === 'LOAN' && l.ref) out.set(l.ref, (out.get(l.ref) ?? 0) + l.amount);
    return out;
  }

  async loans(user: AuthUser, q: MonthQuery) {
    const rows = await this.prisma.employeeLoan.findMany({
      where: { tenantId: user.tenantId, ...(q.employeeId ? { employeeId: q.employeeId } : {}) },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    const rec = await this.recovered(rows.map((r) => r.id));
    return rows.map((l) => ({ ...l, principal: l.principal / 100, emi: l.emi / 100, recovered: (rec.get(l.id) ?? 0) / 100, outstanding: (l.principal - (rec.get(l.id) ?? 0)) / 100 }));
  }

  async addLoan(user: AuthUser, dto: LoanDto) {
    await this.scope.assertOther(user, dto.employeeId);
    if (dto.emi > dto.principal) throw new AppError(400, 'EMI_TOO_LARGE', 'The EMI is larger than the loan');
    return this.audit.run({
      action: 'LOAN_CREATED',
      targetType: 'Employee',
      targetId: dto.employeeId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => tx.employeeLoan.create({ data: { ...dto, principal: paise(dto.principal), emi: paise(dto.emi), tenantId: user.tenantId, createdBy: user.sub } }),
    });
  }

  async closeLoan(user: AuthUser, id: string) {
    const l = await this.prisma.employeeLoan.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!l) throw new AppError(404, 'NOT_FOUND', 'Loan not found');
    return this.audit.run({
      action: 'LOAN_CLOSED',
      targetType: 'Employee',
      targetId: l.employeeId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ loanId: id }),
      run: (tx) => tx.employeeLoan.update({ where: { id }, data: { status: 'CLOSED' } }),
    });
  }

  // Runs

  private presentRun(r: RunRow, settings: PayrollSettings, today: Ymd) {
    const run = { ...r, periodStart: ymdOf(r.periodStart), periodEnd: ymdOf(r.periodEnd) };
    return { ...run, locked: isLocked(run, settings, today) };
  }

  async runs(user: AuthUser) {
    const [t, rows] = await this.prisma.$transaction((tx) => Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
      tx.payrollRun.findMany({ where: { tenantId: user.tenantId }, orderBy: { periodStart: 'desc' }, take: 60 }),
    ]));
    const s = payrollSettingsOf(t.settings);
    return rows.map((r) => this.presentRun(r, s, this.today(t)));
  }

  /** Payable days for everyone employed in a period, from attendance as it is now. */
  private async attendance(tenantId: string, start: Ymd, end: Ymd, employeeIds: string[]) {
    const [days, unpaid] = await this.prisma.$transaction((tx) => Promise.all([
      tx.attendanceDay.findMany({
        where: { tenantId, employeeId: { in: employeeIds }, workDate: { gte: dbDate(start), lte: dbDate(end) } },
        select: { employeeId: true, workDate: true, status: true, leavePortion: true, leaveTypeId: true, isLate: true, isEarlyExit: true, overtimeMinutes: true, finalizedAt: true, policy: true },
        orderBy: { workDate: 'asc' },
      }),
      tx.leaveType.findMany({ where: { tenantId, paid: false }, select: { id: true } }),
    ]), { timeout: BATCH_TIMEOUT_MS });
    const byEmployee = new Map<string, DayInput[]>();
    for (const d of days) {
      const list = byEmployee.get(d.employeeId) ?? [];
      list.push({
        workDate: ymdOf(d.workDate),
        status: d.status,
        leavePortion: Number(d.leavePortion),
        leaveTypeId: d.leaveTypeId,
        isLate: d.isLate,
        isEarlyExit: d.isEarlyExit,
        overtimeMinutes: d.overtimeMinutes,
        finalized: Boolean(d.finalizedAt),
        policy: d.policy as Record<string, unknown>,
      });
      byEmployee.set(d.employeeId, list);
    }
    return { byEmployee, unpaid: new Set(unpaid.map((u) => u.id)) };
  }

  private employedIn(tenantId: string, start: Ymd, end: Ymd) {
    return this.prisma.employee.findMany({
      where: { tenantId, joinedOn: { lte: dbDate(end) }, OR: [{ exitOn: null }, { exitOn: { gte: dbDate(start) } }] },
      include: {
        salaries: { where: { effectiveFrom: { lte: dbDate(end) } }, orderBy: { effectiveFrom: 'desc' }, take: 1, include: { structure: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });
  }

  /** Create the month's DRAFT run, or recompute it while it is still a draft. */
  async compute(user: AuthUser, dto: RunDto) {
    const t = await this.tenant(user.tenantId);
    const settings = payrollSettingsOf(t.settings);
    const today = this.today(t);
    const existing = await this.prisma.payrollRun.findUnique({ where: { tenantId_month: { tenantId: user.tenantId, month: dto.month } } });
    if (existing && existing.status !== 'DRAFT') throw new AppError(409, 'RUN_CLOSED', `Payroll for ${dto.month} is already ${existing.status.toLowerCase()}`);

    let start: Ymd;
    let end: Ymd;
    let transition = false;
    if (existing) {
      [start, end] = [ymdOf(existing.periodStart), ymdOf(existing.periodEnd)];
    } else {
      const previous = await this.prisma.payrollRun.findFirst({ where: { tenantId: user.tenantId }, orderBy: { periodEnd: 'desc' } });
      if (previous && previous.month >= dto.month) throw new AppError(409, 'OUT_OF_ORDER', `Payroll already exists for ${previous.month}; run months in order`);
      try {
        ({ start, end, transition } = nextPeriod(dto.month, settings.cycleStartDay, previous ? ymdOf(previous.periodEnd) : null));
      } catch (err) {
        throw new AppError(409, 'BAD_PERIOD', (err as Error).message);
      }
    }
    if (end >= today && !dto.force) throw new AppError(409, 'PERIOD_NOT_OVER', `The pay period ends on ${end}; run it after that, or force it`);

    const employees = (await this.employedIn(user.tenantId, start, end)).filter((e) => e.salaries.length);
    const withoutSalary = await this.prisma.employee.count({
      where: { tenantId: user.tenantId, status: 'ACTIVE', joinedOn: { lte: dbDate(end) }, salaries: { none: { effectiveFrom: { lte: dbDate(end) } } } },
    });
    const ids = employees.map((e) => e.id);
    const { byEmployee, unpaid } = await this.attendance(user.tenantId, start, end, ids);
    const pending = [...byEmployee.values()].reduce((s, list) => s + list.filter((d) => !d.finalized).length, 0);
    if (pending && !dto.force) throw new AppError(409, 'ATTENDANCE_NOT_FINAL', `${pending} attendance days in the period are not finalised yet; wait for them or force the run`, { pending });

    const [adjustments, loans, claims] = await this.prisma.$transaction((tx) => Promise.all([
      tx.payrollAdjustment.findMany({ where: { tenantId: user.tenantId, month: dto.month, payslipId: null, employeeId: { in: ids } } }),
      tx.employeeLoan.findMany({ where: { tenantId: user.tenantId, status: 'ACTIVE', startMonth: { lte: dto.month }, employeeId: { in: ids } } }),
      tx.expenseClaim.findMany({ where: { tenantId: user.tenantId, status: 'APPROVED', payslipId: null, claimDate: { lte: dbDate(end) }, employeeId: { in: ids } } }),
    ]));
    const recovered = await this.recovered(loans.map((l) => l.id));

    const warnings: string[] = [];
    if (transition) warnings.push(`Transition period ${start} – ${end}: the pay cycle changed since the last run`);
    if (pending) warnings.push(`${pending} attendance days were not finalised when this was computed`);
    if (withoutSalary) warnings.push(`${withoutSalary} active employees have no salary set and are left out`);

    const slips = employees.map((e) => {
      const salary = e.salaries[0];
      const days = payableDays(byEmployee.get(e.id) ?? [], { start, end }, ymdOf(e.joinedOn), e.exitOn ? ymdOf(e.exitOn) : null, unpaid);
      const result = computePayslip({
        month: dto.month,
        days,
        settings,
        salary: {
          monthlyGross: salary.monthlyGross,
          components: salary.structure.components as unknown as Component[],
          overrides: salary.overrides as Record<string, number>,
          pf: salary.pf,
          esi: salary.esi,
          pt: salary.pt,
          ptState: salary.ptState,
        },
        adjustments: adjustments.filter((a) => a.employeeId === e.id).map((a) => ({ id: a.id, kind: a.kind as 'EARNING' | 'DEDUCTION', code: a.code, amount: a.amount, note: a.note })),
        loans: loans.filter((l) => l.employeeId === e.id).map((l) => ({ id: l.id, emi: l.emi, outstanding: l.principal - (recovered.get(l.id) ?? 0) })),
        reimbursements: claims.filter((c) => c.employeeId === e.id).map((c) => ({ id: c.id, amount: c.amount, category: c.category })),
      });
      for (const w of result.warnings) warnings.push(`${e.employeeCode}: ${w}`);
      if ((e.paymentMode ?? 'BANK') === 'BANK' && (!e.bankAccountNumber || !e.bankIfsc)) warnings.push(`${e.employeeCode}: bank details missing`);
      return {
        tenantId: user.tenantId,
        employeeId: e.id,
        attendance: { ...days, monthlyGross: salary.monthlyGross, structure: salary.structure.name } as unknown as Prisma.InputJsonValue,
        lines: result.lines as unknown as Prisma.InputJsonValue,
        gross: result.gross,
        deductions: result.deductions,
        net: result.net,
        employerContrib: result.employerContrib,
        paymentMode: e.paymentMode ?? 'BANK',
      };
    });
    const totals = {
      employees: slips.length,
      gross: slips.reduce((s, p) => s + p.gross, 0),
      deductions: slips.reduce((s, p) => s + p.deductions, 0),
      net: slips.reduce((s, p) => s + p.net, 0),
      employerContrib: slips.reduce((s, p) => s + p.employerContrib, 0),
    };

    const run = await this.audit.run({
      action: existing ? 'PAYROLL_RECOMPUTED' : 'PAYROLL_CREATED',
      targetType: 'PayrollRun',
      targetId: existing?.id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: dto.month, start, end, ...totals, force: dto.force ?? false }),
      run: async (tx) => {
        const r = existing
          ? await tx.payrollRun.update({ where: { id: existing.id }, data: { totals, warnings, computedAt: new Date() } })
          : await tx.payrollRun.create({ data: { tenantId: user.tenantId, month: dto.month, periodStart: dbDate(start), periodEnd: dbDate(end), totals, warnings, createdBy: user.sub } });
        await tx.payslip.deleteMany({ where: { runId: r.id } });
        await tx.payslip.createMany({ data: slips.map((p) => ({ ...p, runId: r.id })) });
        return r;
      },
    });
    return this.run(user, run.id);
  }

  private async loadRun(user: AuthUser, id: string) {
    const r = await this.prisma.payrollRun.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Payroll run not found');
    return r;
  }

  /** Run + payslip summaries; for a closed run, who's attendance has changed since (to settle as arrears). */
  async run(user: AuthUser, id: string) {
    // Run, tenant and payslips in one transaction; the slips are discarded if the run is not this tenant's.
    const [r, t, slips] = await this.prisma.$transaction((tx) => Promise.all([
      tx.payrollRun.findFirst({ where: { id, tenantId: user.tenantId } }),
      tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
      tx.payslip.findMany({
        where: { runId: id, tenantId: user.tenantId },
        // joinedOn/exitOn feed the drift check only; stripped from the response below.
        include: { employee: { select: { employeeCode: true, fullName: true, designation: true, department: { select: { name: true } }, joinedOn: true, exitOn: true } } },
        orderBy: { employee: { employeeCode: 'asc' } },
      }),
    ]));
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Payroll run not found');
    let drift: Array<{ employeeId: string; employeeCode: string; paidDaysThen: number; paidDaysNow: number; otHoursThen: number; otHoursNow: number }> = [];
    if (r.status !== 'DRAFT') {
      const [start, end] = [ymdOf(r.periodStart), ymdOf(r.periodEnd)];
      const employees = slips.map((s) => ({ id: s.employeeId, joinedOn: s.employee.joinedOn, exitOn: s.employee.exitOn }));
      const { byEmployee, unpaid } = await this.attendance(user.tenantId, start, end, employees.map((e) => e.id));
      drift = employees.flatMap((e) => {
        const now = payableDays(byEmployee.get(e.id) ?? [], { start, end }, ymdOf(e.joinedOn), e.exitOn ? ymdOf(e.exitOn) : null, unpaid);
        const slip = slips.find((s) => s.employeeId === e.id)!;
        const then = slip.attendance as unknown as PayableDays;
        return now.paidDays !== then.paidDays || now.overtimeHours !== then.overtimeHours
          ? [{ employeeId: e.id, employeeCode: slip.employee.employeeCode, paidDaysThen: then.paidDays, paidDaysNow: now.paidDays, otHoursThen: then.overtimeHours, otHoursNow: now.overtimeHours }]
          : [];
      });
    }
    return {
      ...this.presentRun(r, payrollSettingsOf(t.settings), this.today(t)),
      payslips: slips.map(({ employee: { joinedOn: _j, exitOn: _x, ...employee }, ...s }) => ({
        id: s.id,
        employeeId: s.employeeId,
        employee: { ...employee, department: employee.department?.name ?? null },
        attendance: s.attendance,
        lines: s.lines,
        gross: s.gross,
        deductions: s.deductions,
        net: s.net,
        employerContrib: s.employerContrib,
        paymentMode: s.paymentMode,
      })),
      drift,
    };
  }

  async approve(user: AuthUser, id: string) {
    const r = await this.loadRun(user, id);
    if (r.status !== 'DRAFT') throw new AppError(409, 'NOT_DRAFT', `This run is ${r.status.toLowerCase()}`);
    const slips = await this.prisma.payslip.findMany({ where: { runId: id }, select: { id: true, employeeId: true, lines: true } });
    await this.audit.run({
      action: 'PAYROLL_APPROVED',
      targetType: 'PayrollRun',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: r.month, totals: r.totals }),
      run: async (tx) => {
        // Consume what the payslips paid, so the next run doesn't pay it again.
        for (const s of slips) {
          for (const l of s.lines as unknown as Line[]) {
            if (!l.ref) continue;
            if (l.code === 'REIMBURSEMENT') await tx.expenseClaim.updateMany({ where: { id: l.ref, payslipId: null }, data: { payslipId: s.id } });
            else if (l.code !== 'LOAN') await tx.payrollAdjustment.updateMany({ where: { id: l.ref, payslipId: null }, data: { payslipId: s.id } });
          }
        }
        return tx.payrollRun.update({ where: { id }, data: { status: 'APPROVED', approvedBy: user.sub, approvedAt: new Date() } });
      },
    });
    return this.run(user, id);
  }

  async markPaid(user: AuthUser, id: string) {
    const r = await this.loadRun(user, id);
    if (r.status !== 'APPROVED') throw new AppError(409, 'NOT_APPROVED', 'Approve the run before marking it paid');
    const t = await this.tenant(user.tenantId);
    const settings = payrollSettingsOf(t.settings);
    await this.audit.run({
      action: 'PAYROLL_PAID',
      targetType: 'PayrollRun',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: r.month }),
      run: (tx) => tx.payrollRun.update({ where: { id }, data: { status: 'PAID', paidBy: user.sub, paidAt: new Date() } }),
    });
    // Loans fully recovered close themselves.
    const loans = await this.prisma.employeeLoan.findMany({ where: { tenantId: user.tenantId, status: 'ACTIVE' } });
    const rec = await this.recovered(loans.map((l) => l.id));
    const done = loans.filter((l) => (rec.get(l.id) ?? 0) >= l.principal).map((l) => l.id);
    if (done.length) await this.prisma.employeeLoan.updateMany({ where: { id: { in: done } }, data: { status: 'CLOSED' } });

    const people = await this.prisma.payslip.findMany({ where: { runId: id }, select: { employee: { select: { userId: true } } } });
    await this.notifications.notify(user.tenantId, people.map((p) => p.employee.userId), {
      type: 'PAYSLIP_READY',
      title: `Payslip for ${monthName(r.month)}`,
      body: `Your salary for ${monthName(r.month)} has been processed${settings.payDay ? `; it is credited around day ${settings.payDay}` : ''}. Tap to view your payslip.`,
      data: { runId: id, month: r.month },
    });
    return this.run(user, id);
  }

  /** Explicit lock (MANUAL mode, or to close a draft period early). */
  async lock(user: AuthUser, id: string) {
    const r = await this.loadRun(user, id);
    if (r.lockedAt) throw new AppError(409, 'ALREADY_LOCKED', 'Already locked');
    await this.audit.run({
      action: 'PAYROLL_LOCKED',
      targetType: 'PayrollRun',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: r.month }),
      run: (tx) => tx.payrollRun.update({ where: { id }, data: { lockedAt: new Date() } }),
    });
    return this.run(user, id);
  }

  /**
   * Admin only, audited. Removes a manual lock; an APPROVED run also goes back
   * to DRAFT (what it consumed is released) so corrections can land and it can
   * be recomputed. A PAID run stays closed: settle changes as arrears.
   */
  async unlock(user: AuthUser, id: string) {
    const r = await this.loadRun(user, id);
    if (r.status === 'PAID') throw new AppError(409, 'PAID_RUN', 'This payroll has been paid; add corrections as arrears in the next run');
    const slipIds = (await this.prisma.payslip.findMany({ where: { runId: id }, select: { id: true } })).map((s) => s.id);
    await this.audit.run({
      action: 'PAYROLL_UNLOCKED',
      targetType: 'PayrollRun',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: r.month, status: r.status }),
      run: async (tx) => {
        if (r.status === 'APPROVED') {
          await tx.payrollAdjustment.updateMany({ where: { payslipId: { in: slipIds } }, data: { payslipId: null } });
          await tx.expenseClaim.updateMany({ where: { payslipId: { in: slipIds } }, data: { payslipId: null } });
        }
        return tx.payrollRun.update({ where: { id }, data: { lockedAt: null, ...(r.status === 'APPROVED' ? { status: 'DRAFT', approvedBy: null, approvedAt: null } : {}) } });
      },
    });
    return this.run(user, id);
  }

  async remove(user: AuthUser, id: string) {
    const r = await this.loadRun(user, id);
    if (r.status !== 'DRAFT') throw new AppError(409, 'NOT_DRAFT', 'Only a draft run can be deleted');
    const later = await this.prisma.payrollRun.count({ where: { tenantId: user.tenantId, periodStart: { gt: r.periodEnd } } });
    if (later) throw new AppError(409, 'NOT_LATEST', 'Only the latest run can be deleted');
    await this.audit.run({
      action: 'PAYROLL_DELETED',
      targetType: 'PayrollRun',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ month: r.month }),
      run: (tx) => tx.payrollRun.delete({ where: { id } }),
    });
    return { deleted: true };
  }

  /** Bulk-transfer sheet for the bank: BANK-mode payslips with net > 0. */
  /**
   * Bulk-transfer list for the bank: BANK-mode payslips with net > 0.
   * xlsx (default): account numbers and IFSC are text cells, so Excel keeps every digit
   * (a CSV opened in Excel shows 5.01002E+13 and drops digits past the 15th).
   * csv: plain values for bank portals that take an upload.
   */
  async bankFile(user: AuthUser, id: string, format: 'xlsx' | 'csv') {
    const r = await this.loadRun(user, id);
    if (r.status === 'DRAFT') throw new AppError(409, 'NOT_APPROVED', 'Approve the run first');
    const slips = await this.prisma.payslip.findMany({ where: { runId: id, paymentMode: 'BANK', net: { gt: 0 } }, include: { employee: true }, orderBy: { employee: { employeeCode: 'asc' } } });
    const header = ['Employee code', 'Name', 'Account holder', 'Account number', 'IFSC', 'Bank', 'Amount', 'Narration', 'Problem'];
    const rows = slips.map((s) => ({
      code: s.employee.employeeCode,
      name: s.employee.fullName,
      holder: s.employee.bankAccountName ?? s.employee.fullName,
      account: s.employee.bankAccountNumber ?? '',
      ifsc: s.employee.bankIfsc ?? '',
      bank: s.employee.bankName ?? '',
      amount: s.net / 100,
      narration: `Salary ${r.month}`,
      problem: !s.employee.bankAccountNumber || !s.employee.bankIfsc ? 'Bank details missing' : '',
    }));
    await this.audit.log({ tenantId: user.tenantId, actor: actorOf(user), action: 'PAYROLL_BANK_FILE', targetType: 'PayrollRun', targetId: id, payload: { rows: rows.length, format } });
    const name = `bank-transfer-${r.month}`;

    if (format === 'csv') {
      const csv = toCsv(header, rows.map((x) => [x.code, x.name, x.holder, x.account, x.ifsc, x.bank, x.amount.toFixed(2), x.narration, x.problem]));
      return new StreamableFile(Buffer.from(csv, 'utf8'), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}.csv"` });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Iverto Attendance';
    const ws = wb.addWorksheet(`Salary ${r.month}`, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { key: 'code', width: 14 }, { key: 'name', width: 24 }, { key: 'holder', width: 26 }, { key: 'account', width: 22 }, { key: 'ifsc', width: 14 },
      { key: 'bank', width: 20 }, { key: 'amount', width: 14 }, { key: 'narration', width: 18 }, { key: 'problem', width: 22 },
    ];
    // Text columns: Excel must never turn an account number into 5.01E+13.
    for (const k of ['code', 'account', 'ifsc']) ws.getColumn(k).numFmt = '@';
    ws.getColumn('amount').numFmt = '#,##0.00';
    const head = ws.addRow(header);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCD0447' } }; c.alignment = { vertical: 'middle' }; });
    head.height = 22;
    for (const x of rows) {
      const row = ws.addRow({ ...x, account: String(x.account), ifsc: String(x.ifsc) });
      if (x.problem) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } }; });
    }
    const total = ws.addRow({ name: `Total (${rows.length} transfer${rows.length === 1 ? '' : 's'})`, amount: Math.round(rows.reduce((t, x) => t + x.amount * 100, 0)) / 100 });
    total.font = { bold: true };
    total.getCell('amount').border = { top: { style: 'thin' } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
    return new StreamableFile(Buffer.from(await wb.xlsx.writeBuffer()), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${name}.xlsx"`,
    });
  }

  /** Payroll register: one row per employee, every component as a column. */
  async register(user: AuthUser, id: string) {
    const r = await this.loadRun(user, id);
    const slips = await this.prisma.payslip.findMany({ where: { runId: id }, include: { employee: { include: { department: true } } }, orderBy: { employee: { employeeCode: 'asc' } } });
    const columns: Array<{ code: string; name: string; kind: string }> = [];
    for (const s of slips) for (const l of s.lines as unknown as Line[]) if (!columns.some((c) => c.code === l.code && c.kind === l.kind)) columns.push({ code: l.code, name: l.code === 'REIMBURSEMENT' ? 'Reimbursements' : l.code === 'LOAN' ? 'Loan EMI' : l.name.split(':')[0].split(' (')[0], kind: l.kind });
    const order = { EARNING: 0, REIMBURSEMENT: 1, DEDUCTION: 2, EMPLOYER: 3 } as Record<string, number>;
    columns.sort((a, b) => order[a.kind] - order[b.kind]);
    const csv = toCsv(
      ['Code', 'Name', 'Department', 'Paid days', 'LOP days', 'OT hours', ...columns.map((c) => c.name), 'Gross', 'Deductions', 'Net pay', 'Employer contributions', 'Payment mode'],
      slips.map((s) => {
        const a = s.attendance as unknown as PayableDays;
        const lines = s.lines as unknown as Line[];
        return [
          s.employee.employeeCode,
          s.employee.fullName,
          s.employee.department?.name ?? '',
          a.paidDays,
          a.lopDays,
          a.overtimeHours,
          ...columns.map((c) => (lines.filter((l) => l.code === c.code && l.kind === c.kind).reduce((t, l) => t + l.amount, 0) / 100).toFixed(2)),
          (s.gross / 100).toFixed(2),
          (s.deductions / 100).toFixed(2),
          (s.net / 100).toFixed(2),
          (s.employerContrib / 100).toFixed(2),
          s.paymentMode,
        ];
      }),
    );
    return new StreamableFile(Buffer.from(csv, 'utf8'), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="payroll-register-${r.month}.csv"` });
  }

  // Payslips

  /** HR/admin: any payslip in scope. An employee: their own, once the run is paid. */
  private async loadPayslip(user: AuthUser, id: string) {
    const s = await this.prisma.payslip.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { run: true, employee: { include: { department: true, site: true } } },
    });
    if (!s) throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
    if (s.employeeId === user.employeeId && !isHrOrAdmin(user)) {
      if (s.run.status !== 'PAID') throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
    } else {
      if (!isHrOrAdmin(user)) throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
      await this.scope.assertEmployee(user, s.employeeId);
    }
    return s;
  }

  /** The caller's payslips from paid runs, newest first. */
  async mine(user: AuthUser) {
    if (!user.employeeId) return [];
    const rows = await this.prisma.payslip.findMany({
      where: { employeeId: user.employeeId, run: { status: 'PAID' } },
      include: { run: { select: { month: true, periodStart: true, periodEnd: true, paidAt: true } } },
      orderBy: { run: { periodStart: 'desc' } },
      take: 36,
    });
    return rows.map((s) => ({
      id: s.id,
      month: s.run.month,
      monthName: monthName(s.run.month),
      periodStart: ymdOf(s.run.periodStart),
      periodEnd: ymdOf(s.run.periodEnd),
      paidAt: s.run.paidAt,
      gross: s.gross / 100,
      deductions: s.deductions / 100,
      net: s.net / 100,
    }));
  }

  /** One employee's payslips across runs: HR/admin see drafts too, the employee only paid ones. */
  async payslipsOf(user: AuthUser, employeeId: string) {
    await this.assertPayAccess(user, employeeId);
    const own = user.employeeId === employeeId && !isHrOrAdmin(user);
    const rows = await this.prisma.payslip.findMany({
      where: { employeeId, ...(own ? { run: { status: 'PAID' } } : {}) },
      include: { run: { select: { id: true, month: true, status: true, periodStart: true, periodEnd: true } } },
      orderBy: { run: { periodStart: 'desc' } },
      take: 60,
    });
    return rows.map((s) => ({
      id: s.id,
      runId: s.run.id,
      month: s.run.month,
      status: s.run.status,
      periodStart: ymdOf(s.run.periodStart),
      periodEnd: ymdOf(s.run.periodEnd),
      paidDays: (s.attendance as unknown as PayableDays).paidDays,
      lopDays: (s.attendance as unknown as PayableDays).lopDays,
      gross: s.gross / 100,
      deductions: s.deductions / 100,
      net: s.net / 100,
    }));
  }

  async payslip(user: AuthUser, id: string) {
    const s = await this.loadPayslip(user, id);
    return {
      id: s.id,
      month: s.run.month,
      periodStart: ymdOf(s.run.periodStart),
      periodEnd: ymdOf(s.run.periodEnd),
      status: s.run.status,
      employee: { id: s.employeeId, employeeCode: s.employee.employeeCode, fullName: s.employee.fullName },
      attendance: s.attendance,
      lines: (s.lines as unknown as Line[]).map((l) => ({ ...l, amount: l.amount / 100, full: l.full !== undefined ? l.full / 100 : undefined })),
      gross: s.gross / 100,
      deductions: s.deductions / 100,
      net: s.net / 100,
      employerContrib: s.employerContrib / 100,
    };
  }

  async payslipPdf(user: AuthUser, id: string) {
    const s = await this.loadPayslip(user, id);
    const t = await this.tenant(user.tenantId);
    const settings = payrollSettingsOf(t.settings);
    const e = s.employee;
    const a = s.attendance as unknown as PayableDays;
    const lines = s.lines as unknown as Line[];
    const of = (k: string) => lines.filter((l) => l.kind === k);
    const mask = (acct?: string | null) => (acct ? `XXXX${acct.slice(-4)}` : '—');
    const fmtDay = (d: Date | null) => (d ? formatLocal(d, 'UTC', 'd MMM yyyy')! : '—');
    const label = { fontSize: 8, color: '#6b7280' };
    const kv = (k: string, v: string) => [{ text: k, ...label }, { text: v, bold: true, fontSize: 9 }];
    const money = (paiseAmount: number) => ({ text: rupees(paiseAmount), alignment: 'right' as const, fontSize: 9 });
    const earnings = [...of('EARNING'), ...of('REIMBURSEMENT')];
    const deductions = of('DEDUCTION');
    const rows = Math.max(earnings.length, deductions.length);
    const body: any[][] = [
      [
        { text: 'Earnings', bold: true, fillColor: '#f3f4f6', fontSize: 9 },
        { text: '₹', bold: true, fillColor: '#f3f4f6', alignment: 'right', fontSize: 9 },
        { text: 'Deductions', bold: true, fillColor: '#f3f4f6', fontSize: 9 },
        { text: '₹', bold: true, fillColor: '#f3f4f6', alignment: 'right', fontSize: 9 },
      ],
    ];
    for (let i = 0; i < rows; i++) {
      const er = earnings[i];
      const de = deductions[i];
      body.push([er ? { text: er.name, fontSize: 9 } : '', er ? money(er.amount) : '', de ? { text: de.name, fontSize: 9 } : '', de ? money(de.amount) : '']);
    }
    body.push([
      { text: 'Gross earnings', bold: true, fontSize: 9 },
      { ...money(s.gross + of('REIMBURSEMENT').reduce((x, l) => x + l.amount, 0)), bold: true },
      { text: 'Total deductions', bold: true, fontSize: 9 },
      { ...money(s.deductions), bold: true },
    ]);
    const employer = of('EMPLOYER');
    const content: any[] = [
      { text: `Payslip for ${monthName(s.run.month)}`, fontSize: 15, bold: true, margin: [0, 0, 0, 2] },
      { text: `Pay period ${fmtDay(s.run.periodStart)} – ${fmtDay(s.run.periodEnd)}${settings.payDay ? ` · credited around day ${settings.payDay}` : ''}`, ...label, margin: [0, 0, 0, 12] },
      {
        table: {
          widths: ['auto', '*', 'auto', '*'],
          body: [
            [...kv('Employee', `${e.fullName} (${e.employeeCode})`), ...kv('Designation', e.designation ?? '—')],
            [...kv('Department', e.department?.name ?? '—'), ...kv('Location', e.site.name)],
            [...kv('Date of joining', fmtDay(e.joinedOn)), ...kv('PAN', e.pan ?? '—')],
            [...kv('UAN', e.uan ?? '—'), ...kv('ESIC', e.esicNumber ?? '—')],
            [...kv('Bank account', `${e.bankName ?? ''} ${mask(e.bankAccountNumber)}`.trim()), ...kv('Payment mode', s.paymentMode)],
            [...kv('Days in period', String(a.periodDays)), ...kv('Paid days', String(a.paidDays))],
            [...kv('Loss of pay days', String(a.lopDays)), ...kv('Overtime hours', String(a.overtimeHours))],
          ],
        },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 3, paddingBottom: () => 3 },
        margin: [0, 0, 0, 14],
      },
      {
        table: { headerRows: 1, widths: ['*', 80, '*', 80], body },
        layout: { hLineColor: () => '#e5e7eb', vLineColor: () => '#e5e7eb', paddingTop: () => 4, paddingBottom: () => 4 },
      },
      {
        margin: [0, 14, 0, 0],
        table: {
          widths: ['*'],
          body: [
            [
              {
                fillColor: '#fce7ef',
                margin: [8, 6, 8, 6],
                stack: [
                  { columns: [{ text: 'Net pay', bold: true, fontSize: 12 }, { text: `₹ ${rupees(s.net)}`, bold: true, fontSize: 14, alignment: 'right', color: '#9f0337' }] },
                  { text: rupeesInWords(s.net), fontSize: 8.5, color: '#374151', margin: [0, 2, 0, 0] },
                ],
              },
            ],
          ],
        },
        layout: 'noBorders',
      },
      ...(employer.length
        ? [{ text: `Employer contributions (not deducted from pay): ${employer.map((l) => `${l.name} ₹${rupees(l.amount)}`).join(' · ')}`, ...label, margin: [0, 10, 0, 0] }]
        : []),
      { text: 'This is a computer-generated payslip and does not need a signature.', ...label, italics: true, margin: [0, 16, 0, 0] },
    ];
    const pdf = await renderBranded(brandOf(t), content, `${brandOf(t).orgName} · Payslip ${s.run.month} · ${e.employeeCode} · Confidential`);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="payslip-${s.run.month}-${e.employeeCode}.pdf"` });
  }
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('payroll')
@RequireFeature('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('settings')
  @Roles('ADMIN', 'HR')
  settings(@CurrentUser() user: AuthUser) {
    return this.payroll.settings(user);
  }

  @Put('settings')
  @Roles('ADMIN', 'HR')
  saveSettings(@CurrentUser() user: AuthUser, @Body() dto: PayrollSettingsDto) {
    return this.payroll.saveSettings(user, dto);
  }

  @Get('structures')
  @Roles('ADMIN', 'HR')
  structures(@CurrentUser() user: AuthUser) {
    return this.payroll.structures(user);
  }

  @Post('structures')
  @Roles('ADMIN', 'HR')
  createStructure(@CurrentUser() user: AuthUser, @Body() dto: StructureDto) {
    return this.payroll.saveStructure(user, dto);
  }

  @Patch('structures/:id')
  @Roles('ADMIN', 'HR')
  updateStructure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: StructureDto) {
    return this.payroll.saveStructure(user, dto, id);
  }

  @Get('adjustments')
  @Roles('ADMIN', 'HR')
  adjustments(@CurrentUser() user: AuthUser, @Query() q: MonthQuery) {
    return this.payroll.adjustments(user, q);
  }

  @Post('adjustments')
  @Roles('ADMIN', 'HR')
  addAdjustment(@CurrentUser() user: AuthUser, @Body() dto: AdjustmentDto) {
    return this.payroll.addAdjustment(user, dto);
  }

  @Delete('adjustments/:id')
  @Roles('ADMIN', 'HR')
  removeAdjustment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.removeAdjustment(user, id);
  }

  @Get('loans')
  @Roles('ADMIN', 'HR')
  loans(@CurrentUser() user: AuthUser, @Query() q: MonthQuery) {
    return this.payroll.loans(user, q);
  }

  @Post('loans')
  @Roles('ADMIN', 'HR')
  addLoan(@CurrentUser() user: AuthUser, @Body() dto: LoanDto) {
    return this.payroll.addLoan(user, dto);
  }

  @Post('loans/:id/close')
  @Roles('ADMIN', 'HR')
  closeLoan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.closeLoan(user, id);
  }

  @Get('runs')
  @Roles('ADMIN', 'HR')
  runs(@CurrentUser() user: AuthUser) {
    return this.payroll.runs(user);
  }

  /** Create the month's draft, or recompute it. */
  @Post('runs')
  @Roles('ADMIN', 'HR')
  compute(@CurrentUser() user: AuthUser, @Body() dto: RunDto) {
    return this.payroll.compute(user, dto);
  }

  @Get('runs/:id')
  @Roles('ADMIN', 'HR')
  run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.run(user, id);
  }

  @Post('runs/:id/approve')
  @Roles('ADMIN', 'HR')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.approve(user, id);
  }

  @Post('runs/:id/paid')
  @Roles('ADMIN', 'HR')
  paid(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.markPaid(user, id);
  }

  @Post('runs/:id/lock')
  @Roles('ADMIN', 'HR')
  lock(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.lock(user, id);
  }

  @Post('runs/:id/unlock')
  @Roles('ADMIN')
  unlock(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.unlock(user, id);
  }

  @Delete('runs/:id')
  @Roles('ADMIN', 'HR')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.remove(user, id);
  }

  @Get('runs/:id/bank-file.xlsx')
  @Roles('ADMIN', 'HR')
  bankFileXlsx(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.bankFile(user, id, 'xlsx');
  }

  @Get('runs/:id/bank-file.csv')
  @Roles('ADMIN', 'HR')
  bankFile(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.bankFile(user, id, 'csv');
  }

  @Get('runs/:id/register.csv')
  @Roles('ADMIN', 'HR')
  register(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.register(user, id);
  }

  /** The caller's own payslips (paid runs). */
  @Get('payslips/mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.payroll.mine(user);
  }

  @Get('payslips/:id')
  payslip(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.payslip(user, id);
  }

  @Get('payslips/:id/pdf')
  payslipPdf(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.payslipPdf(user, id);
  }
}

@ApiTags('payroll')
@RequireFeature('payroll')
@Controller('employees/:id/salaries')
export class SalariesController {
  constructor(private readonly payroll: PayrollService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.salaries(user, id);
  }

  @Post()
  @Roles('ADMIN', 'HR')
  set(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SalaryDto) {
    return this.payroll.setSalary(user, id, dto);
  }
}

@ApiTags('payroll')
@RequireFeature('payroll')
@Controller('employees/:id/payslips')
export class EmployeePayslipsController {
  constructor(private readonly payroll: PayrollService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.payslipsOf(user, id);
  }
}

@Module({
  controllers: [PayrollController, SalariesController, EmployeePayslipsController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}

