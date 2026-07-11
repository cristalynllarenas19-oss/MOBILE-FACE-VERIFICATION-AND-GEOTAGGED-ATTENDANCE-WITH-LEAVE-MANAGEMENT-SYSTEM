import { Module } from "@nestjs/common";
import { FaceVerificationModule } from "../face-verification/face-verification.module";
import { GeolocationModule } from "../geolocation/geolocation.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";

@Module({
  imports: [GeolocationModule, FaceVerificationModule, AuditLogsModule, NotificationsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
})
export class AttendanceModule {}
