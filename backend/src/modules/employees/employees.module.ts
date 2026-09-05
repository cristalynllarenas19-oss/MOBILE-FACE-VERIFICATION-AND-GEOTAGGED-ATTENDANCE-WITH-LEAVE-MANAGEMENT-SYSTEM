import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { EvaluationsModule } from "../evaluations/evaluations.module";
import { GeolocationModule } from "../geolocation/geolocation.module";
import { LeaveAccrualModule } from "../leave/leave-accrual.module";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";

@Module({
  imports: [AuditLogsModule, MailModule, GeolocationModule, NotificationsModule, EvaluationsModule, LeaveAccrualModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
})
export class EmployeesModule {}
