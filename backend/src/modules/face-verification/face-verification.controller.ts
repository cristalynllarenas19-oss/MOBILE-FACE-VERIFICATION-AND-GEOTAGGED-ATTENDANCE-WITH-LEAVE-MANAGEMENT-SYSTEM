import { Body, Controller, Post } from "@nestjs/common";
import { FaceVerificationService } from "./face-verification.service";

@Controller("face")
export class FaceVerificationController {
  constructor(private readonly faceService: FaceVerificationService) {}

  @Post("liveness/session")
  createLivenessSession() {
    return this.faceService.createLivenessSession();
  }

  @Post("verify")
  verify(@Body() body: { livenessScore: number; similarityScore: number }) {
    return this.faceService.evaluateScores(body.livenessScore, body.similarityScore);
  }
}
