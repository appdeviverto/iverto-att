import { RequireFeature } from '../common/features';
import { Body, Controller, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Asset, Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { hrSettingsOf } from './hr-settings';

export class AssetDto {
  @IsString() @MinLength(1) @MaxLength(40) tag: string;
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsString() @MinLength(1) @MaxLength(60) category: string;
  @IsOptional() @IsString() @MaxLength(80) serialNo?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}

export class AssignDto {
  @IsString() employeeId: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ReturnDto {
  /** RETIRED = returned damaged / written off. */
  @IsOptional() @IsIn(['IN_STOCK', 'RETIRED']) status?: 'IN_STOCK' | 'RETIRED';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class AssetQuery {
  @IsOptional() @IsIn(['IN_STOCK', 'ASSIGNED', 'RETIRED']) status?: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

const include = { employee: { select: { id: true, fullName: true, employeeCode: true } } } as const;

/** Company assets. Assignment history is the audit log (ASSET_ASSIGNED / ASSET_RETURNED on the asset). */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
  ) {}

  async list(user: AuthUser, q: AssetQuery) {
    // An employee/manager sees what is assigned to people in their scope; HR sees the whole register.
    const where: Prisma.AssetWhereInput = {
      tenantId: user.tenantId,
      ...(isHrOrAdmin(user) ? {} : { employee: await this.scope.employeeWhere(user) }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.q ? { OR: [{ tag: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }, { serialNo: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    return this.prisma.asset.findMany({ where, include, orderBy: [{ category: 'asc' }, { tag: 'asc' }], take: 2000 });
  }

  private async load(user: AuthUser, id: string) {
    const a = await this.prisma.asset.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Asset not found');
    return a;
  }

  async save(user: AuthUser, dto: AssetDto, id?: string) {
    const categories = hrSettingsOf((await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } })).settings).assetCategories;
    if (!categories.includes(dto.category)) throw new AppError(400, 'UNKNOWN_CATEGORY', `category must be one of ${categories.join(', ')}`);
    if (id) await this.load(user, id);
    const clash = await this.prisma.asset.findFirst({ where: { tenantId: user.tenantId, tag: dto.tag, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw new AppError(409, 'DUPLICATE_TAG', `Asset tag ${dto.tag} is already used`);
    return this.audit.run({
      action: id ? 'ASSET_UPDATED' : 'ASSET_CREATED',
      targetType: 'Asset',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => (id ? tx.asset.update({ where: { id }, data: dto, include }) : tx.asset.create({ data: { ...dto, tenantId: user.tenantId }, include })),
    });
  }

  async assign(user: AuthUser, id: string, dto: AssignDto) {
    const a = await this.load(user, id);
    if (a.status !== 'IN_STOCK') throw new AppError(409, 'NOT_IN_STOCK', a.status === 'ASSIGNED' ? 'Return the asset before reassigning it' : 'The asset is retired');
    const e = await this.scope.assertEmployee(user, dto.employeeId);
    if (e.status !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_EXITED', 'Employee has exited');
    return this.audit.run({
      action: 'ASSET_ASSIGNED',
      targetType: 'Asset',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ tag: a.tag, employeeId: e.id, employeeCode: e.employeeCode, note: dto.note ?? null }),
      run: (tx) => tx.asset.update({ where: { id }, data: { status: 'ASSIGNED', employeeId: e.id, assignedAt: new Date() }, include }),
    });
  }

  async giveBack(user: AuthUser, id: string, dto: ReturnDto) {
    const a: Asset = await this.load(user, id);
    if (a.status !== 'ASSIGNED') throw new AppError(409, 'NOT_ASSIGNED', 'The asset is not assigned');
    return this.audit.run({
      action: 'ASSET_RETURNED',
      targetType: 'Asset',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ tag: a.tag, employeeId: a.employeeId, status: dto.status ?? 'IN_STOCK', note: dto.note ?? null }),
      run: (tx) => tx.asset.update({ where: { id }, data: { status: dto.status ?? 'IN_STOCK', employeeId: null, assignedAt: null }, include }),
    });
  }

  async retire(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    if (a.status === 'ASSIGNED') throw new AppError(409, 'ASSIGNED', 'Return the asset first');
    return this.audit.run({
      action: 'ASSET_RETIRED',
      targetType: 'Asset',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ tag: a.tag }),
      run: (tx) => tx.asset.update({ where: { id }, data: { status: 'RETIRED' }, include }),
    });
  }

  /** Who had it when: the asset's audit trail. */
  async history(user: AuthUser, id: string) {
    await this.load(user, id);
    return this.prisma.auditLog.findMany({
      where: { tenantId: user.tenantId, targetType: 'Asset', targetId: id },
      orderBy: { createdAt: 'desc' },
      select: { action: true, payload: true, actorUserId: true, createdAt: true },
    });
  }
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: AssetQuery) {
    return this.assets.list(user, q);
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: AssetDto) {
    return this.assets.save(user, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssetDto) {
    return this.assets.save(user, dto, id);
  }

  @Post(':id/assign')
  @Roles('ADMIN', 'HR')
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.assets.assign(user, id, dto);
  }

  @Post(':id/return')
  @Roles('ADMIN', 'HR')
  giveBack(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReturnDto) {
    return this.assets.giveBack(user, id, dto);
  }

  @Post(':id/retire')
  @Roles('ADMIN', 'HR')
  retire(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.retire(user, id);
  }

  @Get(':id/history')
  @Roles('ADMIN', 'HR')
  history(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assets.history(user, id);
  }
}
