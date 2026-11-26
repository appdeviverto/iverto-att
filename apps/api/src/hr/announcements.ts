import { RequireFeature } from '../common/features';
import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Announcement, Prisma } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications';

export class AnnouncementDto {
  @IsString() @MinLength(2) @MaxLength(160) title: string;
  @IsString() @MinLength(1) @MaxLength(10_000) body: string;
  /** Empty = everyone. A person must match a listed site AND (if given) a listed department. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) siteIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) departmentIds?: string[];
  @IsOptional() @IsBoolean() requiresAck?: boolean;
}

/** Employees an announcement reaches. */
const audience = (a: Pick<Announcement, 'tenantId' | 'siteIds' | 'departmentIds'>): Prisma.EmployeeWhereInput => ({
  tenantId: a.tenantId,
  status: 'ACTIVE',
  ...(a.siteIds.length ? { siteId: { in: a.siteIds } } : {}),
  ...(a.departmentIds.length ? { departmentId: { in: a.departmentIds } } : {}),
});

/**
 * Policy updates and notices. Drafts are edited freely; publishing pushes a
 * notification to the audience and, when acknowledgement is required, HR sees
 * who has read it.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly notifications: NotificationsService,
  ) {}

  /** HR/admin: everything, with ack counts. Everyone else: published ones that reach them. */
  async list(user: AuthUser) {
    if (isHrOrAdmin(user)) {
      const rows = await this.prisma.announcement.findMany({ where: { tenantId: user.tenantId }, include: { _count: { select: { acks: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
      // Audience sizes from one site × department tally instead of a count per announcement.
      const groups = rows.some((a) => a.publishedAt)
        ? await this.prisma.employee.groupBy({ by: ['siteId', 'departmentId'], where: { tenantId: user.tenantId, status: 'ACTIVE' }, _count: { _all: true } })
        : [];
      const reach = (a: Announcement) =>
        groups
          .filter((g) => (!a.siteIds.length || a.siteIds.includes(g.siteId)) && (!a.departmentIds.length || (g.departmentId !== null && a.departmentIds.includes(g.departmentId))))
          .reduce((n, g) => n + g._count._all, 0);
      return rows.map(({ _count, ...a }) => ({ ...a, acks: _count.acks, audience: a.publishedAt ? reach(a) : null }));
    }
    return this.mine(user);
  }

  async mine(user: AuthUser) {
    const me = user.employeeId ? await this.prisma.employee.findFirst({ where: { id: user.employeeId, tenantId: user.tenantId } }) : null;
    const rows = await this.prisma.announcement.findMany({
      where: {
        tenantId: user.tenantId,
        publishedAt: { not: null },
        ...(me
          ? {
              AND: [
                { OR: [{ siteIds: { isEmpty: true } }, { siteIds: { has: me.siteId } }] },
                { OR: [{ departmentIds: { isEmpty: true } }, ...(me.departmentId ? [{ departmentIds: { has: me.departmentId } }] : [])] },
              ],
            }
          : {}),
      },
      include: { acks: { where: { employeeId: me?.id ?? '__none__' }, select: { ackAt: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 100,
    });
    return rows.map(({ acks, ...a }) => ({ ...a, ackAt: acks[0]?.ackAt ?? null }));
  }

  private async load(user: AuthUser, id: string) {
    const a = await this.prisma.announcement.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Announcement not found');
    return a;
  }

  async save(user: AuthUser, dto: AnnouncementDto, id?: string) {
    if (id && (await this.load(user, id)).publishedAt) throw new AppError(409, 'PUBLISHED', 'A published announcement cannot be edited; publish a new one');
    return this.audit.run({
      action: id ? 'ANNOUNCEMENT_UPDATED' : 'ANNOUNCEMENT_CREATED',
      targetType: 'Announcement',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ title: dto.title }),
      run: (tx) =>
        id ? tx.announcement.update({ where: { id }, data: dto }) : tx.announcement.create({ data: { ...dto, tenantId: user.tenantId, createdBy: user.sub } }),
    });
  }

  async publish(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    if (a.publishedAt) throw new AppError(409, 'PUBLISHED', 'Already published');
    const published = await this.audit.run({
      action: 'ANNOUNCEMENT_PUBLISHED',
      targetType: 'Announcement',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ title: a.title }),
      run: (tx) => tx.announcement.update({ where: { id }, data: { publishedAt: new Date() } }),
    });
    const people = await this.prisma.employee.findMany({ where: { ...audience(a), userId: { not: null } }, select: { userId: true } });
    await this.notifications.notify(user.tenantId, people.map((p) => p.userId), {
      type: 'ANNOUNCEMENT',
      title: a.title,
      body: a.body.length > 140 ? `${a.body.slice(0, 137)}…` : a.body,
      data: { id, requiresAck: String(a.requiresAck) },
    });
    return { ...published, notified: people.length };
  }

  async remove(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    await this.audit.run({
      action: 'ANNOUNCEMENT_DELETED',
      targetType: 'Announcement',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ title: a.title }),
      run: (tx) => tx.announcement.delete({ where: { id } }),
    });
    return { deleted: true };
  }

  async ack(user: AuthUser, id: string) {
    if (!user.employeeId) throw new AppError(403, 'NO_EMPLOYEE', 'This login is not linked to an employee');
    const a = await this.load(user, id);
    if (!a.publishedAt) throw new AppError(404, 'NOT_FOUND', 'Announcement not found');
    return this.prisma.announcementAck.upsert({
      where: { announcementId_employeeId: { announcementId: id, employeeId: user.employeeId } },
      create: { tenantId: user.tenantId, announcementId: id, employeeId: user.employeeId },
      update: {},
    });
  }

  /** HR: who in the audience has / hasn't acknowledged. */
  async acks(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    const [people, acks] = await Promise.all([
      this.prisma.employee.findMany({ where: audience(a), select: { id: true, fullName: true, employeeCode: true }, orderBy: { fullName: 'asc' } }),
      this.prisma.announcementAck.findMany({ where: { announcementId: id } }),
    ]);
    const at = new Map(acks.map((x) => [x.employeeId, x.ackAt]));
    return people.map((p) => ({ ...p, ackAt: at.get(p.id) ?? null }));
  }
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.announcements.list(user);
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: AnnouncementDto) {
    return this.announcements.save(user, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AnnouncementDto) {
    return this.announcements.save(user, dto, id);
  }

  @Post(':id/publish')
  @Roles('ADMIN', 'HR')
  publish(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.announcements.publish(user, id);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.announcements.remove(user, id);
  }

  @Post(':id/ack')
  ack(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.announcements.ack(user, id);
  }

  @Get(':id/acks')
  @Roles('ADMIN', 'HR')
  acks(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.announcements.acks(user, id);
  }
}
