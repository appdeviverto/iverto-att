import { featuresOf, RequireFeature } from '../common/features';
import { Body, Controller, Delete, Get, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Employee, EmployeeDocument } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'crypto';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, isHrOrAdmin, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AzureBlobService } from '../common/azure-blob.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { addDays, dbDate, localYmd, ymdOf } from '../common/time';
import { decodeUpload, EXT, UploadDto } from '../common/uploads';
import { IsYmd } from '../common/validators';
import { NotificationsService } from '../notifications/notifications';
import { DOCUMENT_CATEGORIES } from './hr-settings';

export class DocumentDto extends UploadDto {
  @IsIn(DOCUMENT_CATEGORIES) category: (typeof DOCUMENT_CATEGORIES)[number];
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsYmd() expiresOn?: string;
}

export class ExpiringQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

/** SAS links for confidential files: short. */
const LINK_SECONDS = 300;

/**
 * Employee document vault. Files sit in the private Azure `documents`
 * container; only HR/admin and the employee themself can list or open them
 * (a manager cannot), and every link is a 5-minute read-only SAS.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly blobs: AzureBlobService,
    private readonly notifications: NotificationsService,
  ) {}

  /** HR/admin (in scope) or the employee themself. */
  async assertCanSee(user: AuthUser, employeeId: string) {
    if (user.employeeId === employeeId) return this.scope.self(user);
    if (!isHrOrAdmin(user)) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    return this.scope.assertEmployee(user, employeeId);
  }

  present(d: EmployeeDocument) {
    const { fileKey: _k, ...rest } = d;
    return { ...rest, expiresOn: d.expiresOn ? ymdOf(d.expiresOn) : null };
  }

  /** Store a file and its row. Also used for generated letters and payslip PDFs. */
  async file(
    employee: Pick<Employee, 'id' | 'tenantId'>,
    doc: { category: string; name: string; contentType: string; body: Buffer; expiresOn?: string | null; uploadedBy?: string | null; verified?: boolean },
    actor = { type: 'system' as const },
  ) {
    const ext = EXT[doc.contentType as keyof typeof EXT] ?? 'bin';
    const fileKey = `${employee.tenantId}/${employee.id}/${doc.category.toLowerCase()}/${randomUUID()}.${ext}`;
    // Upload first: a row never points at a missing blob; a failed insert only leaves an orphan.
    await this.blobs.upload(fileKey, doc.body, doc.contentType, 'documents');
    const row = await this.audit.run({
      action: 'DOCUMENT_ADDED',
      targetType: 'Employee',
      targetId: employee.id,
      actor,
      tenantId: employee.tenantId,
      payloadFrom: () => ({ category: doc.category, name: doc.name, size: doc.body.byteLength }),
      run: (tx) =>
        tx.employeeDocument.create({
          data: {
            tenantId: employee.tenantId,
            employeeId: employee.id,
            category: doc.category,
            name: doc.name,
            fileKey,
            contentType: doc.contentType,
            size: doc.body.byteLength,
            expiresOn: doc.expiresOn ? dbDate(doc.expiresOn) : null,
            uploadedBy: doc.uploadedBy ?? null,
            ...(doc.verified ? { verifiedAt: new Date(), verifiedBy: doc.uploadedBy ?? null } : {}),
          },
        }),
    });
    return this.present(row);
  }

  async upload(user: AuthUser, employeeId: string, dto: DocumentDto) {
    const employee = await this.assertCanSee(user, employeeId);
    if (dto.category === 'LETTER' && !isHrOrAdmin(user)) throw new AppError(403, 'FORBIDDEN', 'Letters are issued by HR');
    const body = decodeUpload(dto.dataBase64, dto.contentType);
    return this.file(
      employee,
      { category: dto.category, name: dto.name, contentType: dto.contentType, body, expiresOn: dto.expiresOn, uploadedBy: user.sub, verified: isHrOrAdmin(user) },
      actorOf(user) as any,
    );
  }

  async list(user: AuthUser, employeeId: string) {
    await this.assertCanSee(user, employeeId);
    const rows = await this.prisma.employeeDocument.findMany({ where: { employeeId }, orderBy: [{ category: 'asc' }, { createdAt: 'desc' }] });
    return rows.map((d) => this.present(d));
  }

  private async load(user: AuthUser, id: string) {
    const d = await this.prisma.employeeDocument.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!d) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    await this.assertCanSee(user, d.employeeId);
    return d;
  }

  async link(user: AuthUser, id: string) {
    const d = await this.load(user, id);
    const ext = EXT[d.contentType as keyof typeof EXT] ?? 'bin';
    const url = await this.blobs.readUrl(d.fileKey, LINK_SECONDS, 'documents', `${d.name.replace(/[^\w .()-]+/g, '_')}.${ext}`);
    await this.audit.log({ tenantId: user.tenantId, actor: actorOf(user), action: 'DOCUMENT_OPENED', targetType: 'EmployeeDocument', targetId: id, payload: { employeeId: d.employeeId } });
    return { url, expiresInSeconds: LINK_SECONDS, contentType: d.contentType };
  }

  async verify(user: AuthUser, id: string) {
    const d = await this.load(user, id);
    const row = await this.audit.run({
      action: 'DOCUMENT_VERIFIED',
      targetType: 'EmployeeDocument',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: d.employeeId, name: d.name }),
      run: (tx) => tx.employeeDocument.update({ where: { id }, data: { verifiedAt: new Date(), verifiedBy: user.sub } }),
    });
    return this.present(row);
  }

  async remove(user: AuthUser, id: string) {
    const d = await this.load(user, id);
    await this.audit.run({
      action: 'DOCUMENT_DELETED',
      targetType: 'EmployeeDocument',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ employeeId: d.employeeId, name: d.name, category: d.category }),
      run: (tx) => tx.employeeDocument.delete({ where: { id } }),
    });
    await this.blobs.remove([d.fileKey], 'documents');
    return { deleted: true };
  }

  async expiring(user: AuthUser, q: ExpiringQuery) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.prisma.employeeDocument.findMany({
      where: { tenantId: user.tenantId, expiresOn: { not: null, lte: dbDate(addDays(today, q.days ?? 30)) }, employee: { AND: [await this.scope.employeeWhere(user), { status: 'ACTIVE' }] } },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: { expiresOn: 'asc' },
    });
    return rows.map((d) => ({ ...this.present(d), employee: d.employee, expired: ymdOf(d.expiresOn!) < today }));
  }

  /** Daily: tell HR/admins about documents expiring in exactly 30 or 7 days, and the employee too. */
  async notifyExpiring() {
    return runAsSystem(async () => {
      const today = localYmd(new Date(), 'Asia/Kolkata');
      const due = await this.prisma.employeeDocument.findMany({
        where: { expiresOn: { in: [dbDate(addDays(today, 30)), dbDate(addDays(today, 7))] }, employee: { status: 'ACTIVE' } },
        include: { employee: true },
      });
      const hrOn = new Map<string, boolean>();
      for (const d of due) {
        if (!hrOn.has(d.tenantId)) {
          const t = await this.prisma.tenant.findUnique({ where: { id: d.tenantId }, select: { settings: true } });
          hrOn.set(d.tenantId, featuresOf(t?.settings).hr);
        }
        if (!hrOn.get(d.tenantId)) continue;
        const hr = await this.prisma.userProfile.findMany({ where: { tenantId: d.tenantId, role: { in: ['ADMIN', 'HR'] }, status: 'ACTIVE' }, select: { userId: true } });
        const when = ymdOf(d.expiresOn!);
        await this.notifications.notify(d.tenantId, [...hr.map((h) => h.userId), d.employee.userId], {
          type: 'DOCUMENT_EXPIRING',
          title: 'Document expiring',
          body: `${d.employee.fullName}: ${d.name} expires on ${when}`,
          data: { id: d.id, employeeId: d.employeeId },
        });
      }
      return due.length;
    });
  }
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller()
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get('documents/expiring')
  @Roles('ADMIN', 'HR')
  expiring(@CurrentUser() user: AuthUser, @Query() q: ExpiringQuery) {
    return this.docs.expiring(user, q);
  }

  @Get('employees/:id/documents')
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.docs.list(user, id);
  }

  @Post('employees/:id/documents')
  upload(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DocumentDto) {
    return this.docs.upload(user, id, dto);
  }

  /** A 5-minute download link. */
  @Get('documents/:id/url')
  link(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.docs.link(user, id);
  }

  @Post('documents/:id/verify')
  @Roles('ADMIN', 'HR')
  verify(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.docs.verify(user, id);
  }

  @Delete('documents/:id')
  @Roles('ADMIN', 'HR')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.docs.remove(user, id);
  }
}
