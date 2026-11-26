import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, isHrOrAdmin, SkipMfa } from '../auth/auth.types';
import { ScopeService } from '../auth/scope.service';
import { RequireFeature } from '../common/features';
import { PrismaService } from '../common/prisma.service';
import { EmployeesService } from '../employees/employees';
import { SELF_EDITABLE_KEYS } from '../employees/fields';
import { ProfileRequestDto, ProfileRequestQuery, ProfileRequestsService } from '../employees/profile-requests';
import { AnnouncementsService } from '../hr/announcements';
import { AssetsService } from '../hr/assets';
import { ChecklistsService, TaskDoneDto } from '../hr/checklists';
import { DocumentDto, DocumentsService } from '../hr/documents';
import { ExpenseDto, ExpenseQuery, ExpensesService } from '../hr/expenses';
import { hrSettingsOf } from '../hr/hr-settings';
import { PayrollService } from '../payroll/payroll';
import { IdempotencyInterceptor } from './idempotency';

/**
 * The app's HR & payroll screens (docs/mobile_api.md §12): the same services
 * as the web, behind /mobile so a password-only (aal1) session reaches them.
 * Everything here is the caller's own data; managers decide expense claims
 * through the shared /mobile/approvals?type=expense routes.
 */
/**
 * These routes skip 2FA, so HR/admin reach them as a plain employee: a password-only session must
 * never open other people's payslips, documents or HR tasks (those stay behind web 2FA).
 */
const own = (u: AuthUser): AuthUser => (isHrOrAdmin(u) ? { ...u, role: 'EMPLOYEE' } : u);

@ApiTags('mobile')
@Controller('mobile')
@SkipMfa()
@UseInterceptors(IdempotencyInterceptor)
export class MobileHrController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly employees: EmployeesService,
    private readonly profile: ProfileRequestsService,
    private readonly documents: DocumentsService,
    private readonly payroll: PayrollService,
    private readonly expenses: ExpensesService,
    private readonly announcements: AnnouncementsService,
    private readonly assets: AssetsService,
    private readonly tasks: ChecklistsService,
  ) {}

  // Profile

  /** The full own record (sensitive fields included: it is the employee's own), what they may change, and any pending change. */
  @Get('profile')
  async getProfile(@CurrentUser() user: AuthUser) {
    const self = await this.scope.self(user);
    // Same row as `self` (already tenant-checked), with the names the profile shows, plus any pending change.
    const [e, pending] = await this.prisma.$transaction((tx) => Promise.all([
      tx.employee.findUniqueOrThrow({
        where: { id: self.id },
        include: { site: { select: { name: true } }, department: { select: { name: true } }, manager: { select: { fullName: true, employeeCode: true } } },
      }),
      tx.profileChangeRequest.findFirst({ where: { employeeId: self.id, status: 'PENDING' } }),
    ]));
    return { employee: this.employees.present(e, user), editable: SELF_EDITABLE_KEYS, pendingRequest: pending };
  }

  @Get('profile/requests')
  profileRequests(@CurrentUser() user: AuthUser, @Query() q: ProfileRequestQuery) {
    return this.profile.list(user, q, true);
  }

  @Post('profile/requests')
  requestProfileChange(@CurrentUser() user: AuthUser, @Body() dto: ProfileRequestDto) {
    return this.profile.create(user, dto);
  }

  @Post('profile/requests/:id/cancel')
  cancelProfileChange(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profile.decide(user, id, 'CANCELLED');
  }

  // Documents

  @RequireFeature('hr')
  @Get('documents')
  async myDocuments(@CurrentUser() user: AuthUser) {
    const self = await this.scope.self(user);
    return this.documents.list(user, self.id);
  }

  @RequireFeature('hr')
  @Post('documents')
  async uploadDocument(@CurrentUser() user: AuthUser, @Body() dto: DocumentDto) {
    const self = await this.scope.self(user);
    return this.documents.upload(user, self.id, dto);
  }

  @RequireFeature('hr')
  @Get('documents/:id/url')
  documentUrl(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documents.link(own(user), id);
  }

  // Payslips

  @RequireFeature('payroll')
  @Get('payslips')
  payslips(@CurrentUser() user: AuthUser) {
    return this.payroll.mine(own(user));
  }

  @RequireFeature('payroll')
  @Get('payslips/:id')
  payslip(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.payslip(own(user), id);
  }

  @RequireFeature('payroll')
  @Get('payslips/:id/pdf')
  payslipPdf(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.payslipPdf(own(user), id);
  }

  // Expenses

  @RequireFeature('hr')
  @Get('expense-categories')
  async expenseCategories(@CurrentUser() user: AuthUser) {
    const t = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { settings: true } });
    return hrSettingsOf(t.settings).expenseCategories;
  }

  @RequireFeature('hr')
  @Get('expenses')
  myExpenses(@CurrentUser() user: AuthUser, @Query() q: ExpenseQuery) {
    return this.expenses.list(user, q, true);
  }

  @RequireFeature('hr')
  @Post('expenses')
  claim(@CurrentUser() user: AuthUser, @Body() dto: ExpenseDto) {
    return this.expenses.create(user, dto);
  }

  @RequireFeature('hr')
  @Post('expenses/:id/cancel')
  cancelClaim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.expenses.decide(user, id, 'CANCELLED');
  }

  // Announcements, assets, tasks, org chart

  @RequireFeature('hr')
  @Get('announcements')
  myAnnouncements(@CurrentUser() user: AuthUser) {
    return this.announcements.mine(user);
  }

  @RequireFeature('hr')
  @Post('announcements/:id/ack')
  ack(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.announcements.ack(user, id);
  }

  @RequireFeature('hr')
  @Get('assets')
  async myAssets(@CurrentUser() user: AuthUser) {
    const self = await this.scope.self(user);
    return this.assets.list(user, { employeeId: self.id });
  }

  @RequireFeature('hr')
  @Get('tasks')
  myTasks(@CurrentUser() user: AuthUser) {
    return this.tasks.mine(own(user), {});
  }

  @RequireFeature('hr')
  @Post('tasks/:id/done')
  taskDone(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TaskDoneDto) {
    return this.tasks.setDone(own(user), id, true, dto.note);
  }

  @RequireFeature('hr')
  @Get('org-chart')
  orgChart(@CurrentUser() user: AuthUser) {
    return this.employees.orgChart(user);
  }
}
