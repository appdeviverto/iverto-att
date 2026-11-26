import { mergeTenantSettings, RequireFeature } from '../common/features';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { PrismaService } from '../common/prisma.service';

export const TASK_ROLES = ['HR', 'IT', 'MANAGER', 'EMPLOYEE'] as const;
export type TaskRole = (typeof TASK_ROLES)[number];
export const DOCUMENT_CATEGORIES = ['ID_PROOF', 'ADDRESS_PROOF', 'EDUCATION', 'EXPERIENCE', 'CONTRACT', 'LETTER', 'OTHER'] as const;

export interface ChecklistItem {
  title: string;
  assigneeRole: TaskRole;
  /** Days after joining (onboarding) or relative to the exit date (offboarding; negative = before). */
  dueDays: number;
}

export interface HrSettings {
  checklists: { ONBOARDING: ChecklistItem[]; OFFBOARDING: ChecklistItem[] };
  expenseCategories: string[];
  assetCategories: string[];
  /** Expense claims need the manager and then HR/admin (two levels). */
  expenseRequiresHrApproval: boolean;
}

export const DEFAULT_HR: HrSettings = {
  checklists: {
    ONBOARDING: [
      { title: 'Collect ID and address proofs', assigneeRole: 'HR', dueDays: 0 },
      { title: 'Collect PAN, UAN and bank details', assigneeRole: 'HR', dueDays: 3 },
      { title: 'Enrol face on the attendance terminal', assigneeRole: 'HR', dueDays: 1 },
      { title: 'Issue laptop, ID card and other assets', assigneeRole: 'IT', dueDays: 0 },
      { title: 'Create email and system accounts', assigneeRole: 'IT', dueDays: 0 },
      { title: 'Team introduction and first-week plan', assigneeRole: 'MANAGER', dueDays: 1 },
      { title: 'Read and sign the appointment letter', assigneeRole: 'EMPLOYEE', dueDays: 7 },
    ],
    OFFBOARDING: [
      { title: 'Knowledge handover', assigneeRole: 'MANAGER', dueDays: -7 },
      { title: 'Exit interview', assigneeRole: 'HR', dueDays: -1 },
      { title: 'Revoke email and system access', assigneeRole: 'IT', dueDays: 0 },
      { title: 'Issue relieving and experience letters', assigneeRole: 'HR', dueDays: 0 },
      { title: 'Full & final settlement', assigneeRole: 'HR', dueDays: 30 },
    ],
  },
  expenseCategories: ['Travel', 'Local conveyance', 'Food', 'Lodging', 'Fuel', 'Phone & internet', 'Client meeting', 'Other'],
  expenseRequiresHrApproval: true,
  assetCategories: ['Laptop', 'Desktop', 'Mobile phone', 'SIM card', 'ID card', 'Access card', 'Vehicle', 'Other'],
};

export function hrSettingsOf(settings: unknown): HrSettings {
  const hr = ((settings as Record<string, any> | null)?.hr ?? {}) as Partial<HrSettings>;
  return {
    checklists: { ...DEFAULT_HR.checklists, ...(hr.checklists ?? {}) },
    expenseCategories: hr.expenseCategories?.length ? hr.expenseCategories : DEFAULT_HR.expenseCategories,
    assetCategories: hr.assetCategories?.length ? hr.assetCategories : DEFAULT_HR.assetCategories,
    expenseRequiresHrApproval: hr.expenseRequiresHrApproval ?? DEFAULT_HR.expenseRequiresHrApproval,
  };
}

class ChecklistItemDto {
  @IsString() @MinLength(1) @MaxLength(160) title: string;
  @IsIn(TASK_ROLES) assigneeRole: TaskRole;
  @Type(() => Number) @IsInt() @Min(-90) @Max(180) dueDays: number;
}

class ChecklistsDto {
  @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto) ONBOARDING: ChecklistItemDto[];
  @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto) OFFBOARDING: ChecklistItemDto[];
}

export class HrSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => ChecklistsDto) checklists?: ChecklistsDto;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(60, { each: true }) expenseCategories?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(60, { each: true }) assetCategories?: string[];
  @IsOptional() @IsBoolean() expenseRequiresHrApproval?: boolean;
}

@ApiTags('hr')
@RequireFeature('hr')
@Controller('hr/settings')
export class HrSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
  ) {}

  /** Everyone: the app needs the expense categories. */
  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const t = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
    return { ...hrSettingsOf(t.settings), documentCategories: DOCUMENT_CATEGORIES, taskRoles: TASK_ROLES };
  }

  @Put()
  @Roles('ADMIN', 'HR')
  async put(@CurrentUser() user: AuthUser, @Body() dto: HrSettingsDto) {
    const t = await this.audit.run({
      action: 'HR_SETTINGS_UPDATED',
      targetType: 'Tenant',
      targetId: user.tenantId,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) => mergeTenantSettings(tx, user.tenantId, { ...dto }, 'hr'),
    });
    return hrSettingsOf(t.settings);
  }
}
