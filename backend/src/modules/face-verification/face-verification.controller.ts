import { BadRequestException, Body, Controller, Post, Req } from "@nestjs/common";
import { DetectFaceDto } from "./dto/detect-face.dto";
import { MatchFaceDto } from "./dto/match-face.dto";
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

  @Post("detect")
  detect(@Body() dto: DetectFaceDto) {
    return this.faceService.detectFace(dto.imageBase64, dto.precise ?? false);
  }

  // Post-liveness identity check (see matchEmployeeFace's doc comment) — not
  // the authoritative decision, only used to stop a wrong-person scan before
  // the client shows a verified state. employeeId always comes from the caller's
  // own JWT, never from the request body, so this can never be used to
  // check a photo against some other employee's enrolled profile.
  @Post("match")
  match(@Req() request: Request, @Body() dto: MatchFaceDto) {
    const employeeId = (request as any).user?.employeeId;
    if (!employeeId) {
      throw new BadRequestException("This account isn't linked to an employee record.");
    }
    return this.faceService.matchEmployeeFace(employeeId, dto.imageBase64);
  }
}
