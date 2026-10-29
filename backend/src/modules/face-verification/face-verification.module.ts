import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { FaceVerificationController } from "./face-verification.controller";
import { FaceVerificationService } from "./face-verification.service";
import { RegistrationLivenessService } from "./registration-liveness.service";

@Module({
  imports: [NotificationsModule],
  controllers: [FaceVerificationController],
  providers: [FaceVerificationService, RegistrationLivenessService],
  exports: [FaceVerificationService, RegistrationLivenessService],
})
export class FaceVerificationModule {}
