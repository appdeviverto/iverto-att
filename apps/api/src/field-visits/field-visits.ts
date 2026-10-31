import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FieldVisit, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBase64, IsBoolean, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { AuthUser, CurrentUser } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AzureBlobService } from '../common/azure-blob.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { addDays, formatLocal, localYmd, zonedInstant } from '../common/time';
import { IsYmd } from '../common/validators';
import { decodeSelfie } from '../remote/remote';

export class FieldVisitDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @Type(() => Number) @IsNumber() @Min(0) accuracy: number;
  @IsOptional() @IsBoolean() isMockLocation?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Base64 JPEG taken in-app at that moment. */
  @IsBase64() selfieBase64: string;
}

export class FieldVisitQuery {
  @IsOptional() @IsString() employeeId?: string;
  /** Local day (the employee's site timezone). */
  @IsOptional() @IsYmd() date?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

type VisitRow = FieldVisit & { employee: { fullName: string; employeeCode: string; site: { timezone: string } } };

/**
 * Field visits: a geotagged, server-timestamped selfie taken in the app while
 * working away from the office (e.g. at a client's). Unlike a mobile punch it
 * never counts as attendance by itself; the employee attaches one to a
 * correction request as proof, and the approver sees the photo and the map.
 */
@Injectable()
export class FieldVisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly blobs: AzureBlobService,
  ) {}

  async present(v: VisitRow) {
    const tz = v.employee.site.timezone;
    return {
      id: v.id,
      employeeId: v.employeeId,
      employee: { fullName: v.employee.fullName, employeeCode: v.employee.employeeCode },
      takenAt: v.takenAt,
      local: formatLocal(v.takenAt, tz, 'yyyy-MM-dd HH:mm'),
      timezone: tz,
      lat: v.lat,
      lng: v.lng,
      accuracy: v.accuracy,
      isMockLocation: v.isMockLocation,
      note: v.note,
      photoUrl: await this.blobs.readUrl(v.photoKey),
    };
  }

  async create(user: AuthUser, dto: FieldVisitDto) {
    const employee = await this.scope.self(user);
    if (employee.status !== 'ACTIVE') throw new AppError(403, 'EMPLOYEE_EXITED', 'Employee has exited');
    const selfie = decodeSelfie(dto.selfieBase64);
    const takenAt = new Date();
    const photoKey = `${employee.tenantId}/${employee.id}/field/${localYmd(takenAt, employee.site.timezone)}/${randomUUID()}.jpg`;
    await this.blobs.upload(photoKey, selfie, 'image/jpeg');
    const visit = await this.prisma.fieldVisit.create({
      data: {
        tenantId: employee.tenantId,
        employeeId: employee.id,
        takenAt,
        lat: dto.lat,
        lng: dto.lng,
        accuracy: dto.accuracy,
        isMockLocation: dto.isMockLocation ?? null,
        note: dto.note,
        photoKey,
      },
      include: { employee: { include: { site: true } } },
    });
    return this.present(visit);
  }

  /** Newest first. `mineOnly` for the app; otherwise everyone in the caller's scope. */
  async list(user: AuthUser, q: FieldVisitQuery, mineOnly = false) {
    const limit = q.limit ?? 50;
    const employeeId = mineOnly ? (user.employeeId ?? '__none__') : q.employeeId;
    const where: Prisma.FieldVisitWhereInput = {
      tenantId: user.tenantId,
      employee: { AND: [mineOnly ? {} : await this.scope.employeeWhere(user), employeeId ? { id: employeeId } : {}] },
    };
    if (q.date) {
      // The day in the employee's timezone when we know whose visits these are, else the tenant's.
      const tz = employeeId
        ? (await this.prisma.employee.findFirst({ where: { id: employeeId, tenantId: user.tenantId }, include: { site: true } }))?.site.timezone
        : ((await this.prisma.tenant.findUnique({ where: { id: user.tenantId } }))?.settings as any)?.timezone;
      const zone = tz || 'Asia/Kolkata';
      where.takenAt = { gte: zonedInstant(q.date, '00:00', zone), lt: zonedInstant(addDays(q.date, 1), '00:00', zone) };
    }
    const rows = await this.prisma.fieldVisit.findMany({
      where,
      include: { employee: { include: { site: true } } },
      orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const data = await Promise.all(rows.slice(0, limit).map((v) => this.present(v)));
    return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
  }
}

@ApiTags('field-visits')
@Controller('field-visits')
export class FieldVisitsController {
  constructor(private readonly visits: FieldVisitsService) {}

  /** Scoped like every other employee list: an EMPLOYEE sees only their own. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: FieldVisitQuery) {
    return this.visits.list(user, q);
  }
}

@Module({
  controllers: [FieldVisitsController],
  providers: [FieldVisitsService],
  exports: [FieldVisitsService],
})
export class FieldVisitsModule {}
