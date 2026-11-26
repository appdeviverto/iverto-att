import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AttendanceCoreModule } from './attendance/attendance-core.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/errors';
import { redisOptions } from './common/redis.service';
import { EmployeesModule } from './employees/employees';
import { FieldVisitsModule } from './field-visits/field-visits';
import { HealthModule } from './health';
import { HrModule } from './hr/hr.module';
import { JobsModule } from './jobs/jobs';
import { LeaveModule } from './leave/leave';
import { LiveModule } from './live/live.module';
import { MobileModule } from './mobile/mobile';
import { NotificationsModule } from './notifications/notifications';
import { OrgModule } from './org/org';
import { PayrollModule } from './payroll/payroll';
import { PlatformAnnouncementsModule } from './platform/announcements';
import { PlatformModule } from './platform/platform';
import { PublicApiModule } from './public-api/public-api.module';
import { PunchesModule } from './punches/punches';
import { RemoteModule } from './remote/remote';
import { ReportsModule } from './reports/reports';
import { ScheduleModule } from './schedule/schedule';
import { TerminalsModule } from './terminals/terminals.module';
import { UsersModule } from './users/users.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({ connection: redisOptions() }),
    // Infrastructure (global)
    CommonModule,
    AuthModule,
    AuditModule,
    LiveModule,
    NotificationsModule,
    AttendanceCoreModule,
    // Domain
    PlatformModule,
    PlatformAnnouncementsModule,
    UsersModule,
    OrgModule,
    EmployeesModule,
    TerminalsModule,
    PunchesModule,
    ScheduleModule,
    AttendanceModule,
    LeaveModule,
    RemoteModule,
    FieldVisitsModule,
    HrModule,
    PayrollModule,
    ReportsModule,
    MobileModule,
    PublicApiModule,
    JobsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
