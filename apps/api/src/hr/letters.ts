import { RequireFeature } from '../common/features';
import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { formatLocal, localYmd } from '../common/time';
import { DocumentsService } from './documents';
import { brandOf, renderBranded, rupees } from './pdf-docs';

const KINDS = ['OFFER', 'APPOINTMENT', 'EXPERIENCE', 'RELIEVING', 'OTHER'] as const;

export class LetterTemplateDto {
  @IsIn(KINDS) kind: (typeof KINDS)[number];
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsString() @MinLength(1) @MaxLength(20_000) body: string;
}

export class GenerateLetterDto {
  @IsString() templateId: string;
  /** Extra {{placeholders}} for this letter only, e.g. { "offer.validTill": "30 Nov 2026" }. */
  @IsOptional() @IsObject() extra?: Record<string, string>;
  /** false = return the rendered text only (preview), nothing is filed. */
  @IsOptional() @IsBoolean() save?: boolean;
}

export class RenderLetterDto {
  /** The (possibly unsaved) template text from the editor. */
  @IsString() @MaxLength(20_000) body: string;
  /** Fill with this employee's details; omitted = sample values. */
  @IsOptional() @IsString() employeeId?: string;
}

/**
 * Every {{placeholder}} a letter can use, with the label the editor shows on its
 * insert chip and a sample value for the preview. Company fields always come
 * from Settings → Organisation.
 */
export const LETTER_FIELDS: Array<{ key: string; label: string; group: 'Letter' | 'Employee' | 'Company' | 'Salary'; sample: string }> = [
  { key: 'today', label: 'Today’s date', group: 'Letter', sample: '' },
  { key: 'employee.fullName', label: 'Full name', group: 'Employee', sample: 'Priya Sharma' },
  { key: 'employee.employeeCode', label: 'Employee code', group: 'Employee', sample: 'E004' },
  { key: 'employee.designation', label: 'Designation', group: 'Employee', sample: 'Sales Executive' },
  { key: 'employee.department', label: 'Department', group: 'Employee', sample: 'Sales' },
  { key: 'employee.site', label: 'Work location', group: 'Employee', sample: 'Bengaluru HQ' },
  { key: 'employee.manager', label: 'Reporting manager', group: 'Employee', sample: 'Meera Iyer' },
  { key: 'employee.joinedOn', label: 'Joining date', group: 'Employee', sample: '8 Jan 2024' },
  { key: 'employee.probationEndOn', label: 'Probation ends', group: 'Employee', sample: '7 Jul 2024' },
  { key: 'employee.confirmedOn', label: 'Confirmation date', group: 'Employee', sample: '8 Jul 2024' },
  { key: 'employee.exitOn', label: 'Last working day', group: 'Employee', sample: '30 Nov 2026' },
  { key: 'employee.noticePeriodDays', label: 'Notice period (days)', group: 'Employee', sample: '60' },
  { key: 'employee.fatherOrSpouseName', label: 'Father’s / spouse’s name', group: 'Employee', sample: 'Anil Sharma' },
  { key: 'employee.currentAddress', label: 'Employee address', group: 'Employee', sample: '45, Sampige Road, Malleshwaram, Bengaluru' },
  { key: 'salary.monthlyGross', label: 'Monthly gross (₹)', group: 'Salary', sample: '38,000' },
  { key: 'salary.annualGross', label: 'Annual gross (₹)', group: 'Salary', sample: '4,56,000' },
  { key: 'salary.effectiveFrom', label: 'Salary effective from', group: 'Salary', sample: '1 Apr 2026' },
  { key: 'org.name', label: 'Company name', group: 'Company', sample: '' },
  { key: 'org.address', label: 'Company address', group: 'Company', sample: '' },
  { key: 'org.phone', label: 'Company phone', group: 'Company', sample: '' },
  { key: 'org.email', label: 'Company email', group: 'Company', sample: '' },
  { key: 'org.website', label: 'Company website', group: 'Company', sample: '' },
];

/** Ready-made starting points (Settings → Letters → "Use template" copies one into the organisation's own list). */
export const LETTER_LIBRARY: Array<{ key: string; kind: (typeof KINDS)[number]; name: string; description: string; body: string }> = [
  {
    key: 'offer',
    kind: 'OFFER',
    name: 'Offer letter',
    description: 'Role, joining date, salary, probation and notice — sent before joining.',
    body: `{{today}}

Dear {{employee.fullName}},

Subject: Offer of employment

We are pleased to offer you the position of {{employee.designation}} in the {{employee.department}} department at {{org.name}}, based at {{employee.site}}.

Your expected date of joining is {{employee.joinedOn}}. Your gross salary will be ₹{{salary.monthlyGross}} per month (₹{{salary.annualGross}} per annum), structured as per company policy and subject to statutory deductions.

You will be on probation until {{employee.probationEndOn}}. The notice period is {{employee.noticePeriodDays}} days.

Please sign and return a copy of this letter to confirm your acceptance.

We look forward to welcoming you to the team.

For {{org.name}}

Authorised Signatory`,
  },
  {
    key: 'appointment',
    kind: 'APPOINTMENT',
    name: 'Appointment letter',
    description: 'Formal appointment on joining, with code, manager and terms.',
    body: `{{today}}

Dear {{employee.fullName}},

Subject: Letter of appointment

Further to your acceptance of our offer, we are pleased to appoint you as {{employee.designation}} with {{org.name}} with effect from {{employee.joinedOn}}. Your employee code is {{employee.employeeCode}} and you will report to {{employee.manager}}.

Your gross salary is ₹{{salary.monthlyGross}} per month. You will be on probation until {{employee.probationEndOn}}, after which your services may be confirmed in writing. Either party may end the employment by giving {{employee.noticePeriodDays}} days' notice.

You are required to follow the company's policies, including attendance, leave and code of conduct, as amended from time to time.

Please sign the duplicate copy of this letter as your acceptance.

For {{org.name}}

Authorised Signatory

Accepted: ____________________ ({{employee.fullName}})`,
  },
  {
    key: 'confirmation',
    kind: 'OTHER',
    name: 'Confirmation letter',
    description: 'Confirms the employee after a successful probation.',
    body: `{{today}}

Dear {{employee.fullName}},

Subject: Confirmation of employment

We are pleased to inform you that, on successful completion of your probation, your employment as {{employee.designation}} with {{org.name}} is confirmed with effect from {{employee.confirmedOn}}.

All other terms of your appointment remain unchanged. The notice period for either party is {{employee.noticePeriodDays}} days.

We appreciate your contribution and look forward to your continued growth with us.

For {{org.name}}

Authorised Signatory`,
  },
  {
    key: 'salary-revision',
    kind: 'OTHER',
    name: 'Salary revision letter',
    description: 'Announces a new gross salary and the date it applies from.',
    body: `{{today}}

Dear {{employee.fullName}},

Subject: Revision of salary

In recognition of your performance, we are pleased to revise your gross salary to ₹{{salary.monthlyGross}} per month (₹{{salary.annualGross}} per annum) with effect from {{salary.effectiveFrom}}.

All other terms and conditions of your employment remain unchanged.

Thank you for your continued contribution to {{org.name}}.

For {{org.name}}

Authorised Signatory`,
  },
  {
    key: 'experience',
    kind: 'EXPERIENCE',
    name: 'Experience letter',
    description: '“To whomsoever it may concern” certificate of service.',
    body: `{{today}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{employee.fullName}} (Employee code {{employee.employeeCode}}) was employed with {{org.name}} from {{employee.joinedOn}} to {{employee.exitOn}}. At the time of leaving, they held the position of {{employee.designation}} in the {{employee.department}} department.

During their tenure we found them sincere and hardworking. We wish them every success in their future endeavours.

For {{org.name}}

Authorised Signatory`,
  },
  {
    key: 'relieving',
    kind: 'RELIEVING',
    name: 'Relieving letter',
    description: 'Confirms the last working day after resignation and handover.',
    body: `{{today}}

Dear {{employee.fullName}},

Subject: Relieving letter

This refers to your resignation from the position of {{employee.designation}}. We confirm that you have been relieved from the services of {{org.name}} at the close of business on {{employee.exitOn}}, after completing the formalities and handing over your responsibilities.

Your full and final settlement will be processed as per company policy.

We thank you for your contributions and wish you the very best.

For {{org.name}}

Authorised Signatory`,
  },
];

const fmtDate = (d: Date | null | undefined) => (d ? formatLocal(d, 'UTC', 'd MMM yyyy') : '');
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Fills {{placeholders}}; unknown or empty ones come back blank and are listed as missing. */
export function fillLetter(body: string, values: Record<string, string>) {
  const missing = new Set<string>();
  const text = body.replace(TOKEN, (_, key: string) => {
    const v = values[key];
    if (v === undefined || v === '') missing.add(key);
    return v ?? '';
  });
  return { text, missing: [...missing] };
}

@Injectable()
export class LettersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditableActionService,
    private readonly docs: DocumentsService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.letterTemplate.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
  }

  library() {
    return LETTER_LIBRARY.map(({ body, ...l }) => ({ ...l, placeholders: [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]))].length }));
  }

  /** Copies a library letter into the organisation's templates ("Offer letter (2)" when the name is taken). */
  async adopt(user: AuthUser, key: string) {
    const l = LETTER_LIBRARY.find((x) => x.key === key);
    if (!l) throw new AppError(404, 'NOT_FOUND', 'No such starting point');
    const taken = new Set((await this.prisma.letterTemplate.findMany({ where: { tenantId: user.tenantId }, select: { name: true } })).map((t) => t.name));
    let name = l.name;
    for (let n = 2; taken.has(name); n++) name = `${l.name} (${n})`;
    return this.save(user, { kind: l.kind, name, body: l.body });
  }

  async save(user: AuthUser, dto: LetterTemplateDto, id?: string) {
    if (id && !(await this.prisma.letterTemplate.count({ where: { id, tenantId: user.tenantId } }))) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    const clash = await this.prisma.letterTemplate.findFirst({ where: { tenantId: user.tenantId, name: dto.name, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw new AppError(409, 'DUPLICATE_NAME', `A template named “${dto.name}” already exists`);
    return this.audit.run({
      action: id ? 'LETTER_TEMPLATE_UPDATED' : 'LETTER_TEMPLATE_CREATED',
      targetType: 'LetterTemplate',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ kind: dto.kind, name: dto.name }),
      run: (tx) => (id ? tx.letterTemplate.update({ where: { id }, data: dto }) : tx.letterTemplate.create({ data: { ...dto, tenantId: user.tenantId } })),
    });
  }

  async remove(user: AuthUser, id: string) {
    const t = await this.prisma.letterTemplate.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!t) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    await this.audit.run({
      action: 'LETTER_TEMPLATE_DELETED',
      targetType: 'LetterTemplate',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ name: t.name }),
      run: (tx) => tx.letterTemplate.delete({ where: { id } }),
    });
    return { deleted: true };
  }

  private orgValues(tenant: { name: string; settings: unknown }) {
    const b = brandOf(tenant);
    return { 'org.name': b.legalName || b.orgName, 'org.address': (b.address ?? '').replace(/\s*\n\s*/g, ', '), 'org.phone': b.phone ?? '', 'org.email': b.email ?? '', 'org.website': b.website ?? '' };
  }

  /** {{placeholder}} values for one employee. */
  private async values(employeeId: string, tenant: { name: string; settings: unknown }) {
    const e = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { site: true, department: true, manager: { select: { fullName: true } }, salaries: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
    });
    const salary = e.salaries[0];
    return {
      values: {
        today: formatLocal(new Date(), e.site.timezone, 'd MMMM yyyy')!,
        ...this.orgValues(tenant),
        'employee.fullName': e.fullName,
        'employee.employeeCode': e.employeeCode,
        'employee.designation': e.designation ?? '',
        'employee.department': e.department?.name ?? '',
        'employee.site': e.site.name,
        'employee.manager': e.manager?.fullName ?? '',
        'employee.joinedOn': fmtDate(e.joinedOn),
        'employee.exitOn': fmtDate(e.exitOn),
        'employee.probationEndOn': fmtDate(e.probationEndOn),
        'employee.confirmedOn': fmtDate(e.confirmedOn),
        'employee.noticePeriodDays': e.noticePeriodDays?.toString() ?? '',
        'employee.fatherOrSpouseName': e.fatherOrSpouseName ?? '',
        'employee.currentAddress': e.currentAddress ?? '',
        'salary.monthlyGross': salary ? rupees(salary.monthlyGross).replace(/\.00$/, '') : '',
        'salary.annualGross': salary ? rupees(salary.monthlyGross * 12).replace(/\.00$/, '') : '',
        'salary.effectiveFrom': salary ? fmtDate(salary.effectiveFrom) : '',
      } as Record<string, string>,
      employee: e,
    };
  }

  /** Editor: the placeholder chips, with samples for the preview (company ones from the real settings). */
  async fields(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    const org = this.orgValues(tenant) as Record<string, string>;
    const today = formatLocal(new Date(), 'Asia/Kolkata', 'd MMMM yyyy')!;
    return LETTER_FIELDS.map((f) => ({ ...f, sample: f.key === 'today' ? today : (org[f.key] ?? f.sample) }));
  }

  /** Editor preview: the unsaved text filled for an employee, or with sample values. */
  async render(user: AuthUser, dto: RenderLetterDto) {
    if (dto.employeeId) {
      await this.scope.assertEmployee(user, dto.employeeId);
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      return fillLetter(dto.body, (await this.values(dto.employeeId, tenant)).values);
    }
    const samples = Object.fromEntries((await this.fields(user)).map((f) => [f.key, f.sample]));
    return fillLetter(dto.body, samples);
  }

  async generate(user: AuthUser, employeeId: string, dto: GenerateLetterDto) {
    await this.scope.assertEmployee(user, employeeId);
    const [template, tenant] = await Promise.all([
      this.prisma.letterTemplate.findFirst({ where: { id: dto.templateId, tenantId: user.tenantId } }),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
    ]);
    if (!template) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    const { employee, values } = await this.values(employeeId, tenant);
    const { text, missing } = fillLetter(template.body, { ...values, ...(dto.extra ?? {}) });
    if (dto.save === false) return { text, missing };

    const paragraphs = text.split(/\n{2,}/).map((p) => ({ text: p.trim(), margin: [0, 0, 0, 10] as [number, number, number, number] }));
    const pdf = await renderBranded(brandOf(tenant), paragraphs, `${template.name} · ${employee.fullName} (${employee.employeeCode}) · ${localYmd(new Date(), employee.site.timezone)}`);
    const doc = await this.docs.file(
      employee,
      { category: 'LETTER', name: `${template.name} — ${employee.fullName}`, contentType: 'application/pdf', body: pdf, uploadedBy: user.sub, verified: true },
      actorOf(user) as any,
    );
    return { document: doc, missing };
  }
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller()
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get('letter-templates')
  @Roles('ADMIN', 'HR')
  list(@CurrentUser() user: AuthUser) {
    return this.letters.list(user);
  }

  /** Ready-made starting points to copy. */
  @Get('letter-templates/library')
  @Roles('ADMIN', 'HR')
  library() {
    return this.letters.library();
  }

  @Post('letter-templates/library/:key/adopt')
  @Roles('ADMIN', 'HR')
  adopt(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.letters.adopt(user, key);
  }

  /** Placeholder chips for the editor: key, label, group and a sample value. */
  @Get('letter-templates/fields')
  @Roles('ADMIN', 'HR')
  fields(@CurrentUser() user: AuthUser) {
    return this.letters.fields(user);
  }

  /** Live preview of unsaved text, as an employee or with sample values. */
  @Post('letter-templates/render')
  @Roles('ADMIN', 'HR')
  render(@CurrentUser() user: AuthUser, @Body() dto: RenderLetterDto) {
    return this.letters.render(user, dto);
  }

  @Post('letter-templates')
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: LetterTemplateDto) {
    return this.letters.save(user, dto);
  }

  @Patch('letter-templates/:id')
  @Roles('ADMIN', 'HR')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LetterTemplateDto) {
    return this.letters.save(user, dto, id);
  }

  @Delete('letter-templates/:id')
  @Roles('ADMIN', 'HR')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.letters.remove(user, id);
  }

  /** Renders the template for this employee; files it as a LETTER document unless save=false (preview). */
  @Post('employees/:id/letters')
  @Roles('ADMIN', 'HR')
  generate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: GenerateLetterDto) {
    return this.letters.generate(user, id, dto);
  }
}
