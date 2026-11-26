import { featuresOf, RequireFeature } from '../common/features';
import { Body, Controller, Delete, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, EmployeeTask, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { addDays, dbDate, ymdOf } from '../common/time';
import { IsYmd } from '../common/validators';
import { hrSettingsOf, TASK_ROLES, TaskRole } from './hr-settings';

type Kind = 'ONBOARDING' | 'OFFBOARDING';

/**
 * Creates the tenant's checklist for a joiner or leaver, inside the caller's
 * transaction (EmployeesService.create / offboard). Offboarding also lists
 * every asset still assigned, one "return" task each.
 */
export async function seedChecklist(tx: Prisma.TransactionClient, employee: Employee, kind: Kind, settings?: unknown) {
  const s = settings ?? (await tx.tenant.findUniqueOrThrow({ where: { id: employee.tenantId }, select: { settings: true } })).settings;
  if (!featuresOf(s).hr) return;
  const anchor = ymdOf(kind === 'ONBOARDING' ? employee.joinedOn : (employee.exitOn ?? employee.joinedOn));
  const items = hrSettingsOf(s).checklists[kind].map((i) => ({ title: i.title, assigneeRole: i.assigneeRole, dueOn: addDays(anchor, i.dueDays) }));
  if (kind === 'OFFBOARDING') {
    const assets = await tx.asset.findMany({ where: { employeeId: employee.id, status: 'ASSIGNED' } });
    items.push(...assets.map((a) => ({ title: `Return ${a.category.toLowerCase()} ${a.tag} — ${a.name}`, assigneeRole: 'IT' as TaskRole, dueOn: anchor })));
  }
  if (!items.length) return;
  await tx.employeeTask.createMany({
    data: items.map((i) => ({ tenantId: employee.tenantId, employeeId: employee.id, kind, title: i.title, assigneeRole: i.assigneeRole, dueOn: dbDate(i.dueOn) })),
  });
}

export class TaskDto {
  @IsIn(['ONBOARDING', 'OFFBOARDING']) kind: Kind;
  @IsString() @MinLength(1) @MaxLength(160) title: string;
  @IsIn(TASK_ROLES) assigneeRole: TaskRole;
  @IsOptional() @IsYmd() dueOn?: string;
}

export class TaskDoneDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MyTasksQuery {
  /** Include completed tasks too. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() all?: boolean;
}

const present = (t: EmployeeTask & { employee?: { fullName: string; employeeCode: string } }) => ({
  ...t,
  dueOn: t.dueOn ? ymdOf(t.dueOn) : null,
  overdue: !t.doneAt && t.dueOn ? ymdOf(t.dueOn) < new Date().toISOString().slice(0, 10) : false,
});

@Injectable()
export class ChecklistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
  ) {}

  /** Who completes what: HR/admin everything (IT tasks included), a manager their team's MANAGER tasks, an employee their own EMPLOYEE tasks. */
  private async assertCanComplete(user: AuthUser, t: EmployeeTask) {
    if (isHrOrAdmin(user)) return;
    if (t.assigneeRole === 'EMPLOYEE' && t.employeeId === user.employeeId) return;
    if (t.assigneeRole === 'MANAGER' && user.role === 'MANAGER' && t.employeeId !== user.employeeId) {
      await this.scope.assertEmployee(user, t.employeeId);
      return;
    }
    throw new AppError(403, 'NOT_YOUR_TASK', `This is a ${t.assigneeRole} task`);
  }

  async list(user: AuthUser, employeeId: string) {
    await this.scope.assertEmployee(user, employeeId);
    const rows = await this.prisma.employeeTask.findMany({ where: { employeeId }, orderBy: [{ kind: 'asc' }, { dueOn: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(present);
  }

  /** The caller's to-do list across employees. */
  async mine(user: AuthUser, q: MyTasksQuery) {
    const roles: TaskRole[] = isHrOrAdmin(user) ? ['HR', 'IT'] : user.role === 'MANAGER' ? ['MANAGER'] : [];
    const or: Prisma.EmployeeTaskWhereInput[] = [];
    if (roles.length) or.push({ assigneeRole: { in: roles }, employee: await this.scope.employeeWhere(user) });
    if (user.employeeId) or.push({ assigneeRole: 'EMPLOYEE', employeeId: user.employeeId });
    if (!or.length) return [];
    const rows = await this.prisma.employeeTask.findMany({
      where: { tenantId: user.tenantId, OR: or, ...(q.all ? {} : { doneAt: null }) },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: [{ dueOn: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
    return rows.map(present);
  }

  async create(user: AuthUser, employeeId: string, dto: TaskDto) {
    const e = await this.scope.assertEmployee(user, employeeId);
    const t = await this.audit.run({
      action: 'TASK_CREATED',
      targetType: 'Employee',
      targetId: employeeId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.employeeTask.create({
          data: { tenantId: e.tenantId, employeeId, kind: dto.kind, title: dto.title, assigneeRole: dto.assigneeRole, dueOn: dto.dueOn ? dbDate(dto.dueOn) : null },
        }),
    });
    return present(t);
  }

  async setDone(user: AuthUser, id: string, done: boolean, note?: string) {
    const t = await this.prisma.employeeTask.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!t) throw new AppError(404, 'NOT_FOUND', 'Task not found');
    await this.assertCanComplete(user, t);
    const updated = await this.audit.run({
      action: done ? 'TASK_DONE' : 'TASK_REOPENED',
      targetType: 'EmployeeTask',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: t.employeeId, title: t.title, note: note ?? null }),
      run: (tx) =>
        tx.employeeTask.update({ where: { id }, data: done ? { doneAt: new Date(), doneBy: user.sub, note: note ?? t.note } : { doneAt: null, doneBy: null } }),
    });
    return present(updated);
  }

  async remove(user: AuthUser, id: string) {
    const t = await this.prisma.employeeTask.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!t) throw new AppError(404, 'NOT_FOUND', 'Task not found');
    await this.audit.run({
      action: 'TASK_DELETED',
      targetType: 'EmployeeTask',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: t.employeeId, title: t.title }),
      run: (tx) => tx.employeeTask.delete({ where: { id } }),
    });
    return { deleted: true };
  }
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller()
export class ChecklistsController {
  constructor(private readonly tasks: ChecklistsService) {}

  @Get('tasks/mine')
  mine(@CurrentUser() user: AuthUser, @Query() q: MyTasksQuery) {
    return this.tasks.mine(user, q);
  }

  @Get('employees/:id/tasks')
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.list(user, id);
  }

  @Post('employees/:id/tasks')
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TaskDto) {
    return this.tasks.create(user, id, dto);
  }

  @Post('tasks/:id/done')
  done(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TaskDoneDto) {
    return this.tasks.setDone(user, id, true, dto.note);
  }

  @Post('tasks/:id/reopen')
  reopen(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.setDone(user, id, false);
  }

  @Delete('tasks/:id')
  @Roles('ADMIN', 'HR')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.remove(user, id);
  }
}
