import { Body, Controller, Get, HttpCode, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { diffDays, leaveYearOf, localYmd, Ymd } from '../common/time';
import { IsYmd } from '../common/validators';
import { LeaveService } from '../leave/leave';
import { IdempotencyInterceptor } from '../mobile/idempotency';
import { PunchesService } from '../punches/punches';
import { PublicApi } from './api-key.guard';
import { PolicyService } from './policy';
import { EVENTS, Op } from './registry';
import {
  presentAttendanceDay,
  presentDepartment,
  presentEmployee,
  presentLeaveBalance,
  presentLeaveRequest,
  presentLeaveType,
  presentPunch,
  presentSite,
} from './serializers';
import { decodeCursor, encodeCursor, feed, ListQuery, syncCap } from './sync';
import { envelope, EVENT_RETENTION_DAYS } from './webhooks';
import { ApiJobsService, BulkUpsertDto, CreateReportDto, JobListQuery } from './jobs';

/** Date filters on day-grained resources span at most this many days (§7, resource consumption). */
const MAX_RANGE_DAYS = 93;

class EmployeeQuery extends ListQuery {
  @IsOptional() @IsIn(['ACTIVE', 'EXITED']) status?: string;
  @IsOptional() @IsString() @MaxLength(64) siteId?: string;
  @IsOptional() @IsString() @MaxLength(64) departmentId?: string;
  @IsOptional() @IsString() @MaxLength(128) externalId?: string;
  @IsOptional() @IsString() @MaxLength(64) employeeCode?: string;
}

class PunchQuery extends ListQuery {
  @IsOptional() @IsString() @MaxLength(64) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(64) siteId?: string;
  /** punchedAt ≥ from, < to (RFC 3339). */
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

class DayQuery extends ListQuery {
  @IsOptional() @IsString() @MaxLength(64) employeeId?: string;
  @IsOptional() @IsString() @MaxLength(64) siteId?: string;
  /** workDate between from and to inclusive (YYYY-MM-DD), at most 93 days apart. */
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
}

class LeaveRequestQuery extends ListQuery {
  @IsOptional() @IsString() @MaxLength(64) employeeId?: string;
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) status?: string;
  /** Requests overlapping [from, to] (YYYY-MM-DD). */
  @IsOptional() @IsYmd() from?: string;
  @IsOptional() @IsYmd() to?: string;
}

class BalanceQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
  @IsOptional() @IsString() @MaxLength(64) employeeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}

class EventQuery {
  @IsOptional() @IsIn(Object.keys(EVENTS)) type?: string;
  /** Start of the log when there is no cursor (RFC 3339); default: the oldest kept event. */
  @IsOptional() @IsISO8601({ strict: true }) since?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
}

class CreatePunchDto {
  @IsString() @MaxLength(64) employeeId: string;
  @IsISO8601({ strict: true }) punchedAt: string;
  @IsIn(['in', 'out']) direction: 'in' | 'out';
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class DecisionDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class RejectDto {
  @IsString() @MinLength(3) @MaxLength(1000) note: string;
}

function assertRange(from?: string, to?: string) {
  if (from && to && (diffDays(from as Ymd, to as Ymd) < 0 || diffDays(from as Ymd, to as Ymd) > MAX_RANGE_DAYS)) {
    throw new AppError(400, 'RANGE_TOO_LARGE', `from must be on or before to, at most ${MAX_RANGE_DAYS} days apart`);
  }
}

const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/**
 * https://api.iverto.ai/v1/* (app path /v1/public/*). Thin: scoping comes from ScopeService
 * and RLS, permissions from the registry via ApiKeyGuard, shapes from serializers.ts.
 */
@ApiExcludeController()
@PublicApi()
@UseInterceptors(IdempotencyInterceptor)
@Controller('public')
export class PublicV1Controller {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly policies: PolicyService,
    private readonly punches: PunchesService,
    private readonly leave: LeaveService,
    private readonly jobs: ApiJobsService,
  ) {}

  /** 202 + a job; same validation as the CSV import (§12). */
  @Post('employees/bulk')
  @Op('employees.bulk_upsert')
  @HttpCode(202)
  bulkUpsert(@CurrentUser() user: AuthUser, @Body() dto: BulkUpsertDto) {
    return this.jobs.submitBulk(user, dto);
  }

  @Post('reports')
  @Op('reports.create')
  @HttpCode(202)
  createReport(@CurrentUser() user: AuthUser, @Body() dto: CreateReportDto) {
    return this.jobs.submitReport(user, dto);
  }

  @Get('jobs')
  @Op('jobs.list')
  listJobs(@CurrentUser() user: AuthUser, @Query() q: JobListQuery) {
    return this.jobs.list(user, q);
  }

  @Get('jobs/:id')
  @Op('jobs.get')
  getJob(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.jobs.get(user, id);
  }

  /** Site restriction of the key, for tables that carry site_id (RLS enforces it too). */
  private siteWhere(user: AuthUser) {
    return user.siteIds.length ? { siteId: { in: user.siteIds } } : {};
  }

  @Get('me')
  @Op('me.get')
  async me(@CurrentUser() user: AuthUser) {
    const { policy } = await this.policies.forTenant(user.tenantId);
    return {
      object: 'api_key',
      id: user.apiKey!.id,
      name: user.apiKey!.name,
      organisationId: user.tenantId,
      permissions: user.apiKey!.permissions,
      piiAccess: user.apiKey!.piiAccess,
      siteIds: user.siteIds,
      limits: { perMinute: policy.rateLimit.perMinute, perDay: policy.rateLimit.perDay, concurrency: policy.rateLimit.concurrency, keyPerMinute: policy.keyRateCeiling },
      credits: { enabled: policy.credits.enabled },
    };
  }

  @Get('sites')
  @Op('sites.list')
  sites(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'sites',
      object: 'site',
      query: q,
      where: { tenantId: user.tenantId, ...(user.siteIds.length ? { id: { in: user.siteIds } } : {}) },
      find: (args) => this.prisma.site.findMany(args as Prisma.SiteFindManyArgs),
      present: presentSite,
    });
  }

  @Get('departments')
  @Op('departments.list')
  departments(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'departments',
      object: 'department',
      query: q,
      where: { tenantId: user.tenantId },
      find: (args) => this.prisma.department.findMany(args as Prisma.DepartmentFindManyArgs),
      present: presentDepartment,
    });
  }

  @Get('employees')
  @Op('employees.list')
  async employees(@CurrentUser() user: AuthUser, @Query() q: EmployeeQuery) {
    const pii = user.apiKey!.piiAccess;
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        await this.scope.employeeWhere(user),
        {
          ...(q.status && { status: q.status }),
          ...(q.siteId && { siteId: q.siteId }),
          ...(q.departmentId && { departmentId: q.departmentId }),
          ...(q.externalId && { externalId: q.externalId }),
          ...(q.employeeCode && { employeeCode: q.employeeCode }),
        },
      ],
    };
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'employees',
      object: 'employee',
      query: q,
      where,
      find: (args) => this.prisma.employee.findMany(args as Prisma.EmployeeFindManyArgs),
      present: (e) => presentEmployee(e, pii),
    });
  }

  @Get('employees/:id')
  @Op('employees.get')
  async employee(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return presentEmployee(await this.scope.assertEmployee(user, id), user.apiKey!.piiAccess);
  }

  @Get('punches')
  @Op('punches.list')
  punchList(@CurrentUser() user: AuthUser, @Query() q: PunchQuery) {
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'punches',
      object: 'punch',
      query: q,
      where: {
        tenantId: user.tenantId,
        ...this.siteWhere(user),
        ...(q.employeeId && { employeeId: q.employeeId }),
        ...(q.siteId && { siteId: q.siteId }),
        ...((q.from || q.to) && { punchedAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lt: new Date(q.to) }) } }),
      },
      find: (args) => this.prisma.punch.findMany(args as Prisma.PunchFindManyArgs),
      present: presentPunch,
    });
  }

  @Post('punches')
  @Op('punches.create')
  async createPunch(@CurrentUser() user: AuthUser, @Body() dto: CreatePunchDto) {
    const punch = await this.punches.manual(user, { employeeId: dto.employeeId, at: dto.punchedAt, direction: dto.direction, reason: dto.reason });
    if (!punch) throw new AppError(409, 'DUPLICATE', 'This punch was already recorded');
    return presentPunch(punch);
  }

  @Get('attendance-days')
  @Op('attendance_days.list')
  days(@CurrentUser() user: AuthUser, @Query() q: DayQuery) {
    assertRange(q.from, q.to);
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'attendance_days',
      object: 'attendance_day',
      query: q,
      where: {
        tenantId: user.tenantId,
        ...this.siteWhere(user),
        ...(q.employeeId && { employeeId: q.employeeId }),
        ...(q.siteId && { siteId: q.siteId }),
        ...((q.from || q.to) && { workDate: { ...(q.from && { gte: day(q.from) }), ...(q.to && { lte: day(q.to) }) } }),
      },
      find: (args) => this.prisma.attendanceDay.findMany(args as Prisma.AttendanceDayFindManyArgs),
      present: presentAttendanceDay,
    });
  }

  @Get('leave-types')
  @Op('leave_types.list')
  leaveTypes(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'leave_types',
      object: 'leave_type',
      query: q,
      where: { tenantId: user.tenantId },
      find: (args) => this.prisma.leaveType.findMany(args as Prisma.LeaveTypeFindManyArgs),
      present: presentLeaveType,
    });
  }

  @Get('leave-requests')
  @Op('leave_requests.list')
  async leaveRequests(@CurrentUser() user: AuthUser, @Query() q: LeaveRequestQuery) {
    return feed(this.prisma, {
      tenantId: user.tenantId,
      table: 'leave_requests',
      object: 'leave_request',
      query: q,
      where: {
        tenantId: user.tenantId,
        ...(user.siteIds.length && { employee: await this.scope.employeeWhere(user) }),
        ...(q.employeeId && { employeeId: q.employeeId }),
        ...(q.status && { status: q.status }),
        ...(q.to && { startDate: { lte: day(q.to) } }),
        ...(q.from && { endDate: { gte: day(q.from) } }),
      },
      find: (args) => this.prisma.leaveRequest.findMany(args as Prisma.LeaveRequestFindManyArgs),
      present: presentLeaveRequest,
    });
  }

  private async findLeaveRequest(user: AuthUser, id: string) {
    const r = await this.prisma.leaveRequest.findFirst({
      where: { id, tenantId: user.tenantId, ...(user.siteIds.length && { employee: await this.scope.employeeWhere(user) }) },
    });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
    return r;
  }

  @Get('leave-requests/:id')
  @Op('leave_requests.get')
  async leaveRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return presentLeaveRequest(await this.findLeaveRequest(user, id));
  }

  /** A key's approval counts as a manager's: types that require HR approval still wait for HR. */
  @Post('leave-requests/:id/approve')
  @HttpCode(200)
  @Op('leave_requests.approve')
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    await this.findLeaveRequest(user, id);
    await this.leave.approve(user, id, dto.note);
    return presentLeaveRequest(await this.findLeaveRequest(user, id));
  }

  @Post('leave-requests/:id/reject')
  @HttpCode(200)
  @Op('leave_requests.reject')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectDto) {
    await this.findLeaveRequest(user, id);
    await this.leave.reject(user, id, dto.note);
    return presentLeaveRequest(await this.findLeaveRequest(user, id));
  }

  /** Derived (no sync feed): paged by (employeeId, leaveTypeId) for one leave year. */
  @Get('leave-balances')
  @Op('leave_balances.list')
  async balances(@CurrentUser() user: AuthUser, @Query() q: BalanceQuery) {
    const year = q.year ?? leaveYearOf(localYmd(new Date(), 'UTC'));
    const limit = q.limit ?? 50;
    const after = q.cursor ? decodeCursor<{ e: string; l: string }>(q.cursor) : null;
    if (after && (typeof after.e !== 'string' || typeof after.l !== 'string')) throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid');
    const rows = await this.prisma.$transaction((tx) =>
      tx.$queryRaw<Array<{ employee_id: string; leave_type_id: string; leave_year: number; balance: unknown; pending: unknown; available: unknown }>>`
        SELECT b.employee_id, b.leave_type_id, b.leave_year, b.balance, b.pending, b.available
        FROM leave_balances b JOIN employees e ON e.id = b.employee_id
        WHERE b.tenant_id = ${user.tenantId} AND b.leave_year = ${year}
          AND (${q.employeeId ?? null}::text IS NULL OR b.employee_id = ${q.employeeId ?? null})
          AND (cardinality(${user.siteIds}::text[]) = 0 OR e.site_id = ANY(${user.siteIds}::text[]))
          AND (${after?.e ?? null}::text IS NULL OR (b.employee_id, b.leave_type_id) > (${after?.e ?? ''}, ${after?.l ?? ''}))
        ORDER BY b.employee_id, b.leave_type_id
        LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      object: 'list',
      data: page.map(presentLeaveBalance),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last ? encodeCursor({ e: last.employee_id, l: last.leave_type_id }) : null,
    };
  }

  /**
   * The event log (§10): what webhooks deliver, for consumers that poll or missed deliveries.
   * Ordered by (createdAt, id) under the same commit-lag cap as the sync feeds, so a cursor
   * never skips an event; kept 30 days. Only types the key's permissions cover.
   */
  @Get('events')
  @Op('events.list')
  async events(@CurrentUser() user: AuthUser, @Query() q: EventQuery) {
    const limit = q.limit ?? 50;
    const floor = Date.now() - EVENT_RETENTION_DAYS * 86_400_000;
    const types = Object.entries(EVENTS)
      .filter(([t, e]) => (e.permission === null || user.apiKey!.permissions.includes(e.permission)) && (!q.type || q.type === t))
      .map(([t]) => t);
    let after: { t: number; i: string } | null = null;
    if (q.cursor) {
      const c = decodeCursor<{ t: number; i: string }>(q.cursor);
      if (typeof c.t !== 'number' || typeof c.i !== 'string') throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid');
      after = c;
    } else if (q.since) {
      after = { t: Date.parse(q.since), i: '' };
    }
    if (after && after.t < floor) {
      throw new AppError(410, 'SYNC_CURSOR_EXPIRED', `Events are kept for ${EVENT_RETENTION_DAYS} days; this position is older`);
    }
    const cap = await syncCap(this.prisma);
    const rows = await this.prisma.apiEvent.findMany({
      where: {
        AND: [
          { tenantId: user.tenantId, endpointId: null, type: { in: types }, createdAt: { lt: cap, gte: new Date(floor) } },
          user.siteIds.length ? { OR: [{ siteId: null }, { siteId: { in: user.siteIds } }] } : {},
          after ? { OR: [{ createdAt: { gt: new Date(after.t) } }, { createdAt: new Date(after.t), id: { gt: after.i } }] } : {},
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const position = last ? { t: last.createdAt.getTime(), i: last.id } : after;
    return {
      object: 'list',
      data: page.map(envelope),
      hasMore: rows.length > limit,
      nextCursor: position ? encodeCursor(position) : null,
    };
  }
}
