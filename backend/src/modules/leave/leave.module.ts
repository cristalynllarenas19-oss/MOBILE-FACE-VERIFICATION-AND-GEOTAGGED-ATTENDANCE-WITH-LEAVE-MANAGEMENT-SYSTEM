import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { LeaveController } from "./leave.controller";
import { LeaveService } from "./leave.service";
import { LeaveLapseService } from "./leave-lapse.service";
import { LeaveSettingsController } from "./leave-settings.controller";

@Module({
  imports: [NotificationsModule, AuditLogsModule],
  controllers: [LeaveController, LeaveSettingsController],
  providers: [LeaveService, LeaveLapseService],
})
export class LeaveModule {}
