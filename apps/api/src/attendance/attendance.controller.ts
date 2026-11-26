import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles, SkipMfa } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { BATCH_TIMEOUT_MS, PrismaService } from '../common/prisma.service';
import { dbDate, diffDays, eachDay, monthRange, ymdOf } from '../common/time';
import { IsMonth, IsYmd } from '../common/validators';
import { lateDeductionDays } from './engine/compute-day';
import { presentDay, presentPunch, statusCode } from './present';
import { RecomputeQueue } from './recompute.service';

const STATUSES = ['PENDING', 'PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE', 'HALF_LEAVE', 'REMOTE', 'HOLIDAY', 'WEEKLY_OFF'];
const toBool = ({ value }: { value: unknown }) => (value === undefined ? undefined : value === 'true' || value === true);
const toList = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value);

export class EmployeeFilter {
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() employeeId?: string;
}

export class DaysQuery extends EmployeeFilter {
  /** Single day; or use from/to. */
  @IsOptional() @IsYmd() date?: string;
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
  @IsOptional() @Transform(toList) @IsArray() @IsIn(STATUSES, { each: true }) status?: string[];
  @IsOptional() @Transform(toBool) @IsBoolean() isLate?: boolean;
  @IsOptional() @Transform(toBool) @IsBoolean() missedPunch?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) size?: number;
}

export class OverviewQuery extends EmployeeFilter {
  @IsMonth() month: string;
  @IsOptional() @Transform(toBool) @IsBoolean() grid?: boolean;
}

export class RecomputeDto {
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) employeeIds?: string[];
  @IsYmd() from: string;
  @IsYmd() to: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

/** Scope + the common employee filters; project = membership overlapping the range (§11.1). */
export async function scopedEmployees(
  scope: ScopeService,
  user: AuthUser,
  f: EmployeeFilter,
  from?: string,
  to?: string,
): Promise<Prisma.EmployeeWhereInput> {
  return {
    AND: [
      await scope.employeeWhere(user),
      f.siteId ? { siteId: f.siteId } : {},
      f.departmentId ? { departmentId: f.departmentId } : {},
      f.employeeId ? { id: f.employeeId } : {},
      f.projectId
        ? {
            projects: {
              some: {
                projectId: f.projectId,
                ...(to ? { from: { lte: dbDate(to) } } : {}),
                ...(from ? { OR: [{ to: null }, { to: { gte: dbDate(from) } }] } : {}),
              },
            },
          }
        : {},
    ],
  };
}

@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly queue: RecomputeQueue,
    private readonly audit: AuditableActionService,
  ) {}

  /** Daily attendance status. */
  @Get('days')
  async days(@CurrentUser() user: AuthUser, @Query() q: DaysQuery) {
    const from = q.date ?? q.from;
    const to = q.date ?? q.to ?? from;
    if (!from) throw new AppError(400, 'DATE_REQUIRED', 'Pass date, or from and to');
    if (diffDays(from, to) > 92) throw new AppError(400, 'RANGE_TOO_LARGE', 'At most 93 days per request');
    const page = q.page ?? 1;
    const size = q.size ?? 100;
    const where: Prisma.AttendanceDayWhereInput = {
      tenantId: user.tenantId,
      workDate: { gte: dbDate(from), lte: dbDate(to) },
      employee: await scopedEmployees(this.scope, user, q, from, to),
      status: q.status?.length ? { in: q.status } : undefined,
      isLate: q.isLate,
      missedPunch: q.missedPunch,
    };
    const [rows, total] = await this.prisma.$transaction((tx) => Promise.all([
      tx.attendanceDay.findMany({
        where,
        include: { employee: true },
        orderBy: [{ workDate: 'desc' }, { employee: { fullName: 'asc' } }],
        skip: (page - 1) * size,
        take: size,
      }),
      tx.attendanceDay.count({ where }),
    ]));
    return { items: rows.map(presentDay), total, page, size };
  }

  /** Detailed in/out: segments, punches, leave, corrections, audit. */
  @Get('days/:id')
  async day(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const day = await this.prisma.attendanceDay.findFirst({
      where: { id, tenantId: user.tenantId, employee: await this.scope.employeeWhere(user) },
      include: { employee: true },
    });
    if (!day) throw new AppError(404, 'NOT_FOUND', 'Attendance day not found');
    const [punches, leave, remote, corrections, audit] = await this.prisma.$transaction((tx) => Promise.all([
      tx.punch.findMany({
        where: { employeeId: day.employeeId, punchedAt: { gte: day.windowStart, lt: day.windowEnd } },
        include: { employee: true, device: true },
        orderBy: { punchedAt: 'asc' },
      }),
      tx.leaveRequest.findMany({
        where: { employeeId: day.employeeId, startDate: { lte: day.workDate }, endDate: { gte: day.workDate }, status: { in: ['PENDING', 'APPROVED'] } },
        include: { leaveType: true },
      }),
      tx.remoteWorkRequest.findMany({
        where: { employeeId: day.employeeId, startDate: { lte: day.workDate }, endDate: { gte: day.workDate }, status: { in: ['PENDING', 'APPROVED'] } },
      }),
      tx.attendanceCorrection.findMany({ where: { employeeId: day.employeeId, workDate: day.workDate }, orderBy: { createdAt: 'desc' } }),
      tx.auditLog.findMany({ where: { targetType: 'AttendanceDay', targetId: day.id }, orderBy: { createdAt: 'desc' } }),
    ]));
    return {
      ...presentDay(day),
      windowStart: day.windowStart,
      windowEnd: day.windowEnd,
      policy: day.policy,
      punches: punches.map((p) => presentPunch(p, day.timezone)),
      leave,
      remote,
      corrections,
      audit,
    };
  }

  /** Month overview: per-employee totals + per-day distribution (+ muster grid on request). */
  @Get('overview')
  @SkipMfa() // mobile leaderboard (docs/mobile_api.md §10.6)
  async overview(@CurrentUser() user: AuthUser, @Query() q: OverviewQuery) {
    const { from, to } = monthRange(q.month);
    const where: Prisma.AttendanceDayWhereInput = {
      tenantId: user.tenantId,
      workDate: { gte: dbDate(from), lte: dbDate(to) },
      employee: await scopedEmployees(this.scope, user, q, from, to),
    };
    // One transaction, and one groupBy for counts, sums and late/early tallies (folded below).
    const [groups, byDay, employees, policies] = await this.prisma.$transaction((tx) => Promise.all([
      tx.attendanceDay.groupBy({
        by: ['employeeId', 'status', 'isLate', 'isEarlyExit'],
        where,
        _count: { _all: true },
        _sum: { workedMinutes: true, overtimeMinutes: true, lateMinutes: true, earlyExitMinutes: true },
      }),
      tx.attendanceDay.groupBy({ by: ['workDate', 'status'], where, _count: { _all: true } }),
      tx.employee.findMany({
        where: { AND: [where.employee as Prisma.EmployeeWhereInput, { days: { some: { workDate: { gte: dbDate(from), lte: dbDate(to) } } } }] },
        select: { id: true, fullName: true, employeeCode: true, departmentId: true, siteId: true },
        orderBy: { fullName: 'asc' },
      }),
      // The latest day's frozen policy decides the month's late deduction.
      tx.attendanceDay.findMany({ where, distinct: ['employeeId'], orderBy: [{ employeeId: 'asc' }, { workDate: 'desc' }], select: { employeeId: true, policy: true } }),
    ]), { timeout: BATCH_TIMEOUT_MS });

    const totals = employees.map((e) => {
      const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      let lateDays = 0, lateOrEarlyDays = 0, workedMinutes = 0, overtimeMinutes = 0, lateMinutes = 0, earlyExitMinutes = 0;
      for (const r of groups) {
        if (r.employeeId !== e.id) continue;
        const n = r._count._all;
        counts[r.status] = (counts[r.status] ?? 0) + n;
        if (r.isLate) lateDays += n;
        if (r.isLate || r.isEarlyExit) lateOrEarlyDays += n;
        workedMinutes += r._sum.workedMinutes ?? 0;
        overtimeMinutes += r._sum.overtimeMinutes ?? 0;
        lateMinutes += r._sum.lateMinutes ?? 0;
        earlyExitMinutes += r._sum.earlyExitMinutes ?? 0;
      }
      const policy = policies.find((x) => x.employeeId === e.id)?.policy as Record<string, unknown> | undefined;
      const penalised = policy?.earlyExitCountsAsLate === true ? lateOrEarlyDays : lateDays;
      return {
        employee: e,
        counts,
        lateDays,
        lateDeductionDays: lateDeductionDays(penalised, policy),
        workedMinutes,
        overtimeMinutes,
        lateMinutes,
        earlyExitMinutes,
      };
    });
    const distribution = eachDay(from, to).map((date) => ({
      date,
      counts: Object.fromEntries(
        byDay.filter((r) => ymdOf(r.workDate) === date).map((r) => [r.status, r._count._all]),
      ),
    }));

    let grid: Record<string, Record<string, { code: string; isLate: boolean; dayId: string }>> | undefined;
    if (q.grid) {
      const cells = await this.prisma.attendanceDay.findMany({
        where,
        select: { id: true, employeeId: true, workDate: true, status: true, isLate: true, leavePortion: true },
      });
      grid = {};
      for (const c of cells) {
        (grid[c.employeeId] ??= {})[ymdOf(c.workDate)] = { code: statusCode(c), isLate: c.isLate, dayId: c.id };
      }
    }
    return { month: q.month, from, to, totals, distribution, grid };
  }

  /**
   * HR recompute / "re-evaluate history" (§6.6). Rewrites the frozen schedule of
   * every day in range, finalised ones included, and audits the request.
   */
  @Post('recompute')
  @Roles('ADMIN', 'HR')
  async recompute(@CurrentUser() user: AuthUser, @Body() dto: RecomputeDto) {
    if (dto.from > dto.to) throw new AppError(400, 'BAD_RANGE', 'from must be on or before to');
    if (diffDays(dto.from, dto.to) > 366) throw new AppError(400, 'RANGE_TOO_LARGE', 'At most one year per request');
    if (dto.employeeIds?.length) {
      const inScope = await this.prisma.employee.count({
        where: { AND: [await this.scope.employeeWhere(user), { id: { in: dto.employeeIds } }] },
      });
      if (inScope !== new Set(dto.employeeIds).size) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Unknown employee id(s)');
    }
    await this.audit.log({
      tenantId: user.tenantId,
      actor: actorOf(user),
      action: 'ATTENDANCE_REEVALUATE',
      targetType: 'AttendanceDay',
      payload: { ...dto },
    });
    const job = await this.queue.bulk({
      tenantId: user.tenantId,
      employeeIds: dto.employeeIds,
      from: dto.from,
      to: dto.to,
      rematerialise: true,
      includeFinalized: true,
    });
    return { jobId: job.id, status: 'queued' };
  }
}
