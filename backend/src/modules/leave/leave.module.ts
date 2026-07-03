import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { LeaveController } from "./leave.controller";
import { LeaveService } from "./leave.service";

@Module({
  imports: [NotificationsModule, AuditLogsModule],
  controllers: [LeaveController],
  providers: [LeaveService],
})
export class LeaveModule {}
