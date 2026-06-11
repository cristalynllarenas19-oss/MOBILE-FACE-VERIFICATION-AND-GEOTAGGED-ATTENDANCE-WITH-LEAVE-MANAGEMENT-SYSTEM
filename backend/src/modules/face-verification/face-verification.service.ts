import { Injectable } from "@nestjs/common";

@Injectable()
export class FaceVerificationService {
  createLivenessSession() {
    return {
      provider: "aws_rekognition",
      sessionId: "replace-with-aws-create-face-liveness-session-result",
      message: "Connect this method to AWS Rekognition CreateFaceLivenessSession.",
    };
  }

  evaluateScores(livenessScore: number, similarityScore: number) {
    if (livenessScore < 90) {
      return { status: "REJECTED", reason: "Liveness check failed" };
    }

    if (similarityScore >= 95) {
      return { status: "APPROVED", reason: null };
    }

    if (similarityScore >= 90) {
      return { status: "PENDING_REVIEW", reason: "Borderline face match requires HR review" };
    }

    return { status: "REJECTED", reason: "Face does not match enrolled profile" };
  }
}
