import { RequireFeature } from '../common/features';
import { Body, Controller, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ExpenseClaim, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBase64, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'crypto';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { approvalTrack, approverNames } from '../common/approval';
import { AzureBlobService } from '../common/azure-blob.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { dbDate, localYmd, ymdOf } from '../common/time';
import { decodeUpload, EXT, UPLOAD_TYPES, UploadType } from '../common/uploads';
import { IsYmd } from '../common/validators';
import { NotificationsService } from '../notifications/notifications';
import { hrSettingsOf } from './hr-settings';

export class ExpenseDto {
  @IsString() @MinLength(1) @MaxLength(60) category: string;
  /** Rupees (up to 2 decimals). */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(10_000_000) amount: number;
  @IsYmd() claimDate: string;
  @IsString() @MinLength(3) @MaxLength(1000) description: string;
  /** Receipt photo or PDF, base64. */
  @IsOptional() @IsBase64() receiptBase64?: string;
  @IsOptional() @IsIn(UPLOAD_TYPES) receiptType?: UploadType;
  /** A field visit (mobile) as proof of travel. */
  @IsOptional() @IsString() fieldVisitId?: string;
}

export class ExpenseQuery {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) status?: string;
  @IsOptional() @IsString() employeeId?: string;
  /** Only claims waiting on the caller's decision. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() awaitingMe?: boolean;
  /** Approved claims not yet reimbursed. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() unpaid?: boolean;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class DecisionDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Reimbursed outside payroll (cash / separate transfer). */
export const PAID_OUTSIDE = 'EXTERNAL';

type Row = ExpenseClaim & { employee: { fullName: string; employeeCode: string; userId: string | null } };

/**
 * Expense claims: submitted from the app with a receipt (Azure documents
 * container), approved like remote work (manager, then HR when two-level),
 * and reimbursed by the next payroll run unless marked paid outside it.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly blobs: AzureBlobService,
    private readonly notifications: NotificationsService,
  ) {}

  private async settings(tenantId: string) {
    return hrSettingsOf((await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings);
  }

  async present(r: Row, track?: ReturnType<typeof approvalTrack>) {
    const { receiptKey, ...rest } = r;
    return {
      ...rest,
      amount: r.amount / 100,
      claimDate: ymdOf(r.claimDate),
      reimbursed: Boolean(r.payslipId),
      reimbursedOutsidePayroll: r.payslipId === PAID_OUTSIDE,
      receiptUrl: receiptKey ? await this.blobs.readUrl(receiptKey, 300, 'documents') : null,
      ...(track ? { progress: track } : {}),
    };
  }

  async create(user: AuthUser, dto: ExpenseDto) {
    const employee = await this.scope.self(user);
    if (employee.status !== 'ACTIVE') throw new AppError(403, 'EMPLOYEE_EXITED', 'Employee has exited');
    const s = await this.settings(user.tenantId);
    if (!s.expenseCategories.includes(dto.category)) throw new AppError(400, 'UNKNOWN_CATEGORY', `category must be one of ${s.expenseCategories.join(', ')}`);
    if (dto.claimDate > localYmd(new Date(), employee.site.timezone)) throw new AppError(400, 'FUTURE_DATE', 'The expense date is in the future');
    if (Boolean(dto.receiptBase64) !== Boolean(dto.receiptType)) throw new AppError(400, 'RECEIPT_TYPE', 'Give receiptType with the receipt');
    if (dto.fieldVisitId && !(await this.prisma.fieldVisit.count({ where: { id: dto.fieldVisitId, employeeId: employee.id } }))) {
      throw new AppError(400, 'FIELD_VISIT_NOT_FOUND', 'Unknown field visit');
    }
    let receiptKey: string | null = null;
    if (dto.receiptBase64 && dto.receiptType) {
      const body = decodeUpload(dto.receiptBase64, dto.receiptType);
      receiptKey = `${employee.tenantId}/${employee.id}/receipts/${randomUUID()}.${EXT[dto.receiptType]}`;
      await this.blobs.upload(receiptKey, body, dto.receiptType, 'documents');
    }
    const r = await this.audit.run({
      action: 'EXPENSE_SUBMITTED',
      targetType: 'ExpenseClaim',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: employee.id, category: dto.category, amount: dto.amount, claimDate: dto.claimDate }),
      run: (tx) =>
        tx.expenseClaim.create({
          data: {
            tenantId: user.tenantId,
            employeeId: employee.id,
            category: dto.category,
            amount: Math.round(dto.amount * 100),
            claimDate: dbDate(dto.claimDate),
            description: dto.description,
            receiptKey,
            receiptType: dto.receiptType ?? null,
            fieldVisitId: dto.fieldVisitId ?? null,
            createdBy: user.sub,
          },
          include: { employee: { select: { fullName: true, employeeCode: true, userId: true } } },
        }),
    });
    await this.notifications.approvalPending(user.tenantId, employee.id, 'expense', r.id, employee.fullName);
    return this.present(r, approvalTrack(r, s.expenseRequiresHrApproval, await approverNames(this.prisma, [r])));
  }

  async list(user: AuthUser, q: ExpenseQuery, mineOnly = false) {
    const limit = q.limit ?? 50;
    const twoLevel = (await this.settings(user.tenantId)).expenseRequiresHrApproval;
    const and: Prisma.ExpenseClaimWhereInput[] = [
      { tenantId: user.tenantId },
      mineOnly ? { employeeId: user.employeeId ?? '__none__' } : { employee: await this.scope.employeeWhere(user) },
      q.employeeId ? { employeeId: q.employeeId } : {},
      q.status ? { status: q.status } : {},
      q.unpaid ? { status: 'APPROVED', payslipId: null } : {},
    ];
    if (q.awaitingMe) {
      and.push({ status: 'PENDING', employeeId: { not: user.employeeId ?? '__none__' } });
      // HR/admin: everything pending (final say); manager: only what still needs the manager step.
      if (!isHrOrAdmin(user)) and.push({ managerApproverId: null });
      else if (twoLevel) and.push({ OR: [{ managerApproverId: { not: null } }, { employee: { managerId: null } }] });
    }
    const rows = await this.prisma.expenseClaim.findMany({
      where: { AND: and },
      include: { employee: { select: { fullName: true, employeeCode: true, userId: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const names = await approverNames(this.prisma, page);
    const data = await Promise.all(page.map((r) => this.present(r, approvalTrack(r, twoLevel, names))));
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }

  async decide(user: AuthUser, id: string, verdict: 'APPROVED' | 'REJECTED' | 'CANCELLED', note?: string) {
    const r = await this.prisma.expenseClaim.findFirst({ where: { id, tenantId: user.tenantId }, include: { employee: { select: { fullName: true, employeeCode: true, userId: true } } } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Expense claim not found');
    const own = r.employeeId === user.employeeId;
    if (verdict === 'CANCELLED') {
      if (!own) throw new AppError(403, 'FORBIDDEN', 'Only the employee can withdraw a claim');
      if (r.status !== 'PENDING') throw new AppError(409, 'NOT_CANCELLABLE', `This claim is ${r.status.toLowerCase()}`);
    } else {
      await this.scope.assertApprover(user, r.employeeId);
      if (verdict === 'REJECTED' && (note?.trim().length ?? 0) < 3) throw new AppError(400, 'REASON_REQUIRED', 'Give a reason for the rejection');
      if (r.status !== 'PENDING') throw new AppError(409, 'ALREADY_DECIDED', `This claim is already ${r.status.toLowerCase()}`);
    }
    const amount = `₹${(r.amount / 100).toLocaleString('en-IN')}`;
    if (verdict === 'APPROVED' && !isHrOrAdmin(user) && (await this.settings(user.tenantId)).expenseRequiresHrApproval) {
      if (r.managerApproverId) throw new AppError(409, 'AWAITING_HR', 'Already approved by a manager; waiting for HR');
      const passed = await this.audit.run({
        action: 'EXPENSE_MANAGER_APPROVED',
        targetType: 'ExpenseClaim',
        targetId: id,
        actor: actorOf(user),
        tenantId: user.tenantId,
        payloadFrom: () => ({ employeeId: r.employeeId, amount: r.amount, note: note ?? null }),
        run: (tx) =>
          tx.expenseClaim.update({
            where: { id },
            data: { managerApproverId: user.sub, managerDecidedAt: new Date(), decisionNote: note ?? null },
            include: { employee: { select: { fullName: true, employeeCode: true, userId: true } } },
          }),
      });
      await this.notifications.approvalPending(user.tenantId, r.employeeId, 'expense', id, r.employee.fullName, true);
      await this.notifications.notify(r.tenantId, [r.employee.userId], {
        type: 'EXPENSE_MANAGER_APPROVED',
        title: 'Expense approved by your manager',
        body: `Your ${r.category} claim of ${amount} is now waiting for HR`,
        data: { id },
      });
      return this.present(passed);
    }
    const updated = await this.audit.run({
      action: `EXPENSE_${verdict}`,
      targetType: 'ExpenseClaim',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: r.employeeId, amount: r.amount, note: note ?? null }),
      run: (tx) =>
        tx.expenseClaim.update({
          where: { id },
          data: { status: verdict, decidedAt: new Date(), decisionNote: note ?? null, ...(verdict !== 'CANCELLED' ? { approverId: user.sub } : {}) },
          include: { employee: { select: { fullName: true, employeeCode: true, userId: true } } },
        }),
    });
    if (!own) {
      await this.notifications.notify(r.tenantId, [r.employee.userId], {
        type: `EXPENSE_${verdict}`,
        title: `Expense ${verdict.toLowerCase()}`,
        body: `Your ${r.category} claim of ${amount} was ${verdict.toLowerCase()}${note ? `: ${note}` : ''}`,
        data: { id },
      });
    }
    return this.present(updated);
  }

  /** HR reimbursed it outside payroll; the next run leaves it out. */
  async markPaidOutside(user: AuthUser, id: string) {
    const r = await this.prisma.expenseClaim.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Expense claim not found');
    if (r.status !== 'APPROVED' || r.payslipId) throw new AppError(409, 'NOT_PAYABLE', 'Only approved, unreimbursed claims can be marked paid');
    const updated = await this.audit.run({
      action: 'EXPENSE_PAID_OUTSIDE_PAYROLL',
      targetType: 'ExpenseClaim',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: r.employeeId, amount: r.amount }),
      run: (tx) => tx.expenseClaim.update({ where: { id }, data: { payslipId: PAID_OUTSIDE }, include: { employee: { select: { fullName: true, employeeCode: true, userId: true } } } }),
    });
    return this.present(updated);
  }
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ExpenseQuery) {
    return this.expenses.list(user, q);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: ExpenseDto) {
    return this.expenses.create(user, dto);
  }

  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.expenses.decide(user, id, 'APPROVED', dto.note);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.expenses.decide(user, id, 'REJECTED', dto.note);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.expenses.decide(user, id, 'CANCELLED');
  }

  @Post(':id/paid-outside-payroll')
  @Roles('ADMIN', 'HR')
  paidOutside(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.expenses.markPaidOutside(user, id);
  }
}
