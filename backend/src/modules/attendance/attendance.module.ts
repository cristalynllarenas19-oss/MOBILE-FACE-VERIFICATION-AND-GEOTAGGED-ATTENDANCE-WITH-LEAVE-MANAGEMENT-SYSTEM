import { Module } from "@nestjs/common";
import { FaceVerificationModule } from "../face-verification/face-verification.module";
import { GeolocationModule } from "../geolocation/geolocation.module";
import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";

@Module({
  imports: [GeolocationModule, FaceVerificationModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
})
export class AttendanceModule {}
