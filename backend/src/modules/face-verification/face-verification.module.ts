import { Module } from "@nestjs/common";
import { FaceVerificationController } from "./face-verification.controller";
import { FaceVerificationService } from "./face-verification.service";

@Module({
  controllers: [FaceVerificationController],
  providers: [FaceVerificationService],
  exports: [FaceVerificationService],
})
export class FaceVerificationModule {}
