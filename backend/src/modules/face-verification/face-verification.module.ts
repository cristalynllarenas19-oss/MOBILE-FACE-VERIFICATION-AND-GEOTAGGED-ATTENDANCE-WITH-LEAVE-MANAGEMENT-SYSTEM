import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { FaceVerificationController } from "./face-verification.controller";
import { FaceVerificationService } from "./face-verification.service";

@Module({
  imports: [NotificationsModule],
  controllers: [FaceVerificationController],
  providers: [FaceVerificationService],
  exports: [FaceVerificationService],
})
export class FaceVerificationModule {}
