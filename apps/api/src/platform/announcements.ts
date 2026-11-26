import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

export const ANNOUNCEMENT_KINDS = ['UPDATE', 'FEATURE', 'CHANGELOG'] as const;

export class CreatePlatformAnnouncementDto {
  @IsIn(ANNOUNCEMENT_KINDS) kind: (typeof ANNOUNCEMENT_KINDS)[number];
  @IsString() @MinLength(3) @MaxLength(140) title: string;
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}

/** Iverto → org admins. Each admin sees what was published since their last dismissal, once, as a popup. */
@Injectable()
export class PlatformAnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
  ) {}

  list() {
    return this.prisma.platformAnnouncement.findMany({ orderBy: { publishedAt: 'desc' }, take: 200 });
  }

  create(dto: CreatePlatformAnnouncementDto, user: AuthUser) {
    return this.audit.run({
      action: 'PLATFORM_ANNOUNCEMENT_PUBLISHED',
      targetType: 'PlatformAnnouncement',
      actor: actorOf(user),
      tenantId: null,
      payloadFrom: () => ({ kind: dto.kind, title: dto.title }),
      run: (tx) => tx.platformAnnouncement.create({ data: { kind: dto.kind, title: dto.title, body: dto.body, createdBy: user.sub } }),
    });
  }

  /** Withdraws it: admins who haven't dismissed it yet won't see it. */
  async remove(id: string, user: AuthUser) {
    await this.audit.run({
      action: 'PLATFORM_ANNOUNCEMENT_DELETED',
      targetType: 'PlatformAnnouncement',
      targetId: id,
      actor: actorOf(user),
      tenantId: null,
      run: async (tx) => {
        const { count } = await tx.platformAnnouncement.deleteMany({ where: { id } });
        if (!count) throw new AppError(404, 'NOT_FOUND', 'Announcement not found');
      },
    });
  }

  /** Published after the admin's last dismissal (or after their account was created, for a new admin). */
  async unseen(user: AuthUser) {
    if (user.isSuperAdmin) return []; // "Open as admin" is not an org admin
    const profile = await this.prisma.userProfile.findUnique({ where: { userId: user.sub }, select: { announcementsSeenAt: true, createdAt: true } });
    if (!profile) return [];
    return this.prisma.platformAnnouncement.findMany({
      where: { publishedAt: { gt: profile.announcementsSeenAt ?? profile.createdAt } },
      orderBy: { publishedAt: 'desc' },
      take: 10,
    });
  }

  async markSeen(user: AuthUser) {
    if (user.isSuperAdmin) return;
    await this.prisma.userProfile.update({ where: { userId: user.sub }, data: { announcementsSeenAt: new Date() } });
  }
}

@ApiTags('platform')
@Controller('platform/announcements')
@Roles('PLATFORM_ADMIN')
export class PlatformAnnouncementsController {
  constructor(private readonly announcements: PlatformAnnouncementsService) {}

  @Get()
  list() {
    return this.announcements.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePlatformAnnouncementDto) {
    return this.announcements.create(dto, user);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.announcements.remove(id, user);
  }
}

@ApiTags('org')
@Controller('whats-new')
@Roles('ADMIN')
export class WhatsNewController {
  constructor(private readonly announcements: PlatformAnnouncementsService) {}

  @Get()
  unseen(@CurrentUser() user: AuthUser) {
    return this.announcements.unseen(user);
  }

  @Post('seen')
  @HttpCode(204)
  seen(@CurrentUser() user: AuthUser) {
    return this.announcements.markSeen(user);
  }
}

@Module({
  controllers: [PlatformAnnouncementsController, WhatsNewController],
  providers: [PlatformAnnouncementsService],
})
export class PlatformAnnouncementsModule {}
