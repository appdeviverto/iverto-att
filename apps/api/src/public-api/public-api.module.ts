import { Module } from '@nestjs/common';
import { LeaveModule } from '../leave/leave';
import { IdempotencyInterceptor } from '../mobile/idempotency';
import { PunchesModule } from '../punches/punches';
import { ApiAdminService, OrgApiKeysController, PlatformApiController } from './admin';
import { ApiKeyGuard } from './api-key.guard';
import { LimiterService } from './limiter';
import { PolicyService } from './policy';
import { RequestLogService } from './request-log';
import { PublicV1Controller } from './v1';
import { OrgWebhooksController, PlatformWebhooksController, WebhookAdminService, WebhookWorker } from './webhooks';
import { ApiJobsService, ApiJobWorker } from './jobs';
import { EmployeesModule } from '../employees/employees';
import { ReportsModule } from '../reports/reports';
import { ApiAlertsService, OrgApiAlertsController, PlatformApiAlertsController } from './alerts';

/**
 * The developer API (docs/public-api.md). Runs in the main process for now (the VM has
 * ~900 MB); nothing here assumes that, so it can move to its own process without changing a URL.
 */
@Module({
  imports: [LeaveModule, PunchesModule, EmployeesModule, ReportsModule],
  controllers: [PublicV1Controller, OrgApiAlertsController, PlatformApiAlertsController, OrgApiKeysController, PlatformApiController, OrgWebhooksController, PlatformWebhooksController],
  providers: [PolicyService, LimiterService, ApiKeyGuard, RequestLogService, ApiAdminService, IdempotencyInterceptor, WebhookAdminService, WebhookWorker, ApiJobsService, ApiJobWorker, ApiAlertsService],
  exports: [PolicyService, WebhookAdminService, ApiJobsService, ApiAlertsService],
})
export class PublicApiModule {}
