import { Module } from "@nestjs/common";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EvaluationsController } from "./evaluations.controller";
import { EvaluationsService } from "./evaluations.service";

@Module({
  imports: [AuditLogsModule, NotificationsModule],
  controllers: [EvaluationsController],
  providers: [EvaluationsService],
  exports: [EvaluationsService],
})
export class EvaluationsModule {}
