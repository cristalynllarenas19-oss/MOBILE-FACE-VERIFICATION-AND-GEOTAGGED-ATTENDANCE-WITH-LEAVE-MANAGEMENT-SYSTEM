import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { UndertimeController } from "./undertime.controller";
import { UndertimeService } from "./undertime.service";

@Module({
  imports: [NotificationsModule, AuditLogsModule],
  controllers: [UndertimeController],
  providers: [UndertimeService],
})
export class UndertimeModule {}
