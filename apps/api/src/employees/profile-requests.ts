import { Body, Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, Prisma, ProfileChangeRequest } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { dbDate, ymdOf } from '../common/time';
import { NotificationsService } from '../notifications/notifications';
import { coerceField, DATE_KEYS, FIELD, SELF_EDITABLE_KEYS } from './fields';

export class ProfileRequestDto {
  /** { field: value }, self-editable fields only (GET /employees/import/columns marks them). null clears. */
  @IsObject() changes: Record<string, string | number | null>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ProfileRequestQuery {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) status?: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ProfileDecisionDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Validates a change set against the registry; values come back normalised (PAN upper-cased, dates checked). */
export function validateChanges(changes: Record<string, unknown>) {
  const keys = Object.keys(changes);
  if (!keys.length) throw new AppError(400, 'NO_CHANGES', 'Nothing to change');
  const out: Record<string, string | number | null> = {};
  for (const key of keys) {
    if (!SELF_EDITABLE_KEYS.includes(key)) throw new AppError(400, 'NOT_SELF_EDITABLE', `${FIELD[key]?.label ?? key} can only be changed by HR`, [{ field: key, message: 'Not self-editable' }]);
    const v = changes[key];
    if (v === null || v === '') {
      out[key] = null;
      continue;
    }
    const r = coerceField(FIELD[key], String(v));
    if ('error' in r) throw new AppError(400, 'INVALID_FIELD', r.error, [{ field: key, message: r.error }]);
    out[key] = r.value;
  }
  return out;
}

/**
 * Employee self-service profile edits (personal, contact, statutory IDs,
 * bank). Nothing changes until HR approves; then the whole change set lands
 * in one transaction. Bank changes always go through HR — the usual target
 * of payroll fraud.
 */
@Injectable()
export class ProfileRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly notifications: NotificationsService,
  ) {}

  /** `e` = the employee's current row when the caller already loaded it (list); otherwise fetched here. */
  private async present(r: ProfileChangeRequest & { employee?: { fullName: string; employeeCode: string } }, e?: Employee | null) {
    // Old values next to new ones, so the approver sees the diff.
    if (e === undefined) e = await this.prisma.employee.findUnique({ where: { id: r.employeeId } });
    const changes = r.changes as Record<string, unknown>;
    const before = Object.fromEntries(
      Object.keys(changes).map((k) => {
        const v = (e as Record<string, any> | null)?.[k];
        return [k, v instanceof Date ? ymdOf(v) : (v ?? null)];
      }),
    );
    return { ...r, before };
  }

  async create(user: AuthUser, dto: ProfileRequestDto) {
    const employee = await this.scope.self(user);
    const changes = validateChanges(dto.changes);
    if (await this.prisma.profileChangeRequest.count({ where: { employeeId: employee.id, status: 'PENDING' } })) {
      throw new AppError(409, 'PENDING_REQUEST', 'You already have a profile change waiting for HR; cancel it to send a new one');
    }
    const r = await this.audit.run({
      action: 'PROFILE_CHANGE_REQUESTED',
      targetType: 'Employee',
      targetId: employee.id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ fields: Object.keys(changes) }),
      run: (tx) => tx.profileChangeRequest.create({ data: { tenantId: user.tenantId, employeeId: employee.id, changes, reason: dto.reason, createdBy: user.sub } }),
    });
    await this.notifications.approvalPending(user.tenantId, employee.id, 'profile', r.id, employee.fullName, true);
    return this.present(r);
  }

  async list(user: AuthUser, q: ProfileRequestQuery, mineOnly = false) {
    const limit = q.limit ?? 50;
    if (!mineOnly && !isHrOrAdmin(user)) mineOnly = true;
    const where: Prisma.ProfileChangeRequestWhereInput = {
      tenantId: user.tenantId,
      ...(mineOnly ? { employeeId: user.employeeId ?? '__none__' } : { employee: await this.scope.employeeWhere(user) }),
      ...(q.employeeId && !mineOnly ? { employeeId: q.employeeId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const rows = await this.prisma.profileChangeRequest.findMany({
      where,
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const employees = page.length
      ? await this.prisma.employee.findMany({ where: { tenantId: user.tenantId, id: { in: [...new Set(page.map((r) => r.employeeId))] } } })
      : [];
    const byId = new Map(employees.map((e) => [e.id, e]));
    const data = await Promise.all(page.map((r) => this.present(r, byId.get(r.employeeId) ?? null)));
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }

  async decide(user: AuthUser, id: string, verdict: 'APPROVED' | 'REJECTED' | 'CANCELLED', note?: string) {
    const r = await this.prisma.profileChangeRequest.findFirst({ where: { id, tenantId: user.tenantId }, include: { employee: true } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Request not found');
    if (r.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}`);
    if (verdict === 'CANCELLED') {
      if (r.employeeId !== user.employeeId) throw new AppError(403, 'FORBIDDEN', 'Only the employee can withdraw their request');
    } else {
      if (!isHrOrAdmin(user)) throw new AppError(403, 'FORBIDDEN', 'Profile changes are approved by HR');
      await this.scope.assertApprover(user, r.employeeId);
      if (verdict === 'REJECTED' && (note?.trim().length ?? 0) < 3) throw new AppError(400, 'REASON_REQUIRED', 'Give a reason for the rejection');
    }
    // Re-validated at approval: the registry may have tightened since it was sent.
    const changes = verdict === 'APPROVED' ? validateChanges(r.changes as Record<string, unknown>) : {};
    const data = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v !== null && DATE_KEYS.includes(k) ? dbDate(v as string) : v]));
    const updated = await this.audit.run({
      action: `PROFILE_CHANGE_${verdict}`,
      targetType: 'Employee',
      targetId: r.employeeId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ requestId: id, fields: Object.keys(r.changes as object), note: note ?? null }),
      run: async (tx) => {
        if (verdict === 'APPROVED') await tx.employee.update({ where: { id: r.employeeId }, data });
        return tx.profileChangeRequest.update({
          where: { id },
          data: { status: verdict, decidedAt: new Date(), decisionNote: note ?? null, ...(verdict !== 'CANCELLED' ? { approverId: user.sub } : {}) },
        });
      },
    });
    if (verdict !== 'CANCELLED') {
      await this.notifications.notify(r.tenantId, [r.employee.userId], {
        type: `PROFILE_CHANGE_${verdict}`,
        title: `Profile change ${verdict.toLowerCase()}`,
        body: verdict === 'APPROVED' ? 'Your profile has been updated' : `HR did not accept your profile change${note ? `: ${note}` : ''}`,
        data: { id },
      });
    }
    return this.present(updated);
  }
}

@ApiTags('employees')
@Controller('profile-requests')
export class ProfileRequestsController {
  constructor(private readonly requests: ProfileRequestsService) {}

  /** HR/admin: everyone's; others: their own. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ProfileRequestQuery) {
    return this.requests.list(user, q);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: ProfileRequestDto) {
    return this.requests.create(user, dto);
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ProfileDecisionDto) {
    return this.requests.decide(user, id, 'APPROVED', dto.note);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ProfileDecisionDto) {
    return this.requests.decide(user, id, 'REJECTED', dto.note);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.decide(user, id, 'CANCELLED');
  }
}
