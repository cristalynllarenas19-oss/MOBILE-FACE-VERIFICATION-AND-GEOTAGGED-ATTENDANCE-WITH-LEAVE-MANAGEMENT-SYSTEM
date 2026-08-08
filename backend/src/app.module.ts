import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { PermissionsGuard } from "./common/guards/permissions.guard";
import { AnnouncementsModule } from "./modules/announcements/announcements.module";
import { AttendanceModule } from "./modules/attendance/attendance.module";
import { AuditLogsModule } from "./modules/audit-logs/audit-logs.module";
import { AuthModule } from "./modules/auth/auth.module";
import { DepartmentsModule } from "./modules/departments/departments.module";
import { EmployeesModule } from "./modules/employees/employees.module";
import { FaceVerificationModule } from "./modules/face-verification/face-verification.module";
import { FaceProfilesModule } from "./modules/face-profiles/face-profiles.module";
import { GeolocationModule } from "./modules/geolocation/geolocation.module";
import { LeaveModule } from "./modules/leave/leave.module";
import { LeaveTypesModule } from "./modules/leave/leave-types.module";
import { LeaveBalancesModule } from "./modules/leave/leave-balances.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PrismaModule } from "./prisma/prisma.module";
import { UsersModule } from "./modules/users/users.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { SchedulesModule } from "./modules/schedules/schedules.module";
import { UndertimeModule } from "./modules/undertime/undertime.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["backend/.env", ".env", "../.env"],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    DashboardModule,
    UsersModule,
    DepartmentsModule,
    EmployeesModule,
    AttendanceModule,
    FaceVerificationModule,
    FaceProfilesModule,
    GeolocationModule,
    LeaveModule,
    LeaveTypesModule,
    LeaveBalancesModule,
    UndertimeModule,
    NotificationsModule,
    SchedulesModule,
    ReportsModule,
    AuditLogsModule,
    AnnouncementsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
