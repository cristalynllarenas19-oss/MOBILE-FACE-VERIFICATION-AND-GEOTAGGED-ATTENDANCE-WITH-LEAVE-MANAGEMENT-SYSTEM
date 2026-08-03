import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { GeolocationModule } from "../geolocation/geolocation.module";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";

@Module({
  imports: [AuditLogsModule, MailModule, GeolocationModule, NotificationsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
})
export class EmployeesModule {}
