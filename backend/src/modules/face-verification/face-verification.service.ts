import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as path from "path";
import * as canvasLib from "canvas";
import * as faceapi from "face-api.js";

const { Canvas, Image, ImageData } = canvasLib;
faceapi.env.monkeyPatch({ Canvas: Canvas as any, Image: Image as any, ImageData: ImageData as any });

const MODELS_PATH = path.join(process.cwd(), "models");

// Distance thresholds for face-api.js's 128-d face descriptors (Euclidean distance).
// Same calibration the library's own docs/examples use: <=0.45 confident match, <=0.6 borderline.
const APPROVE_DISTANCE = 0.45;
const REVIEW_DISTANCE = 0.6;

@Injectable()
export class FaceVerificationService implements OnModuleInit {
  private readonly logger = new Logger(FaceVerificationService.name);
  private modelsLoadingPromise: Promise<void> | null = null;

  async onModuleInit() {
    await this.ensureModelsLoaded();
  }

  private ensureModelsLoaded() {
    if (!this.modelsLoadingPromise) {
      this.modelsLoadingPromise = Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH),
        faceapi.nets.faceLandmark68TinyNet.loadFromDisk(MODELS_PATH),
        faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH),
      ]).then(() => {
        this.logger.log("Face recognition models loaded");
      });
    }
    return this.modelsLoadingPromise;
  }

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

  async extractDescriptor(buffer: Buffer): Promise<Float32Array | null> {
    await this.ensureModelsLoaded();

    const image = await canvasLib.loadImage(buffer);
    const result = await faceapi
      .detectSingleFace(image as any, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 }))
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    return result?.descriptor ?? null;
  }

  compareDescriptors(enrolled: number[], captured: Float32Array) {
    return faceapi.euclideanDistance(new Float32Array(enrolled), captured);
  }

  evaluateMatch(livenessScore: number, distance: number | null) {
    if (livenessScore < 90) {
      return { status: "REJECTED" as const, reason: "Liveness check failed", similarityScore: 0 };
    }

    if (distance === null) {
      return {
        status: "REJECTED" as const,
        reason: "No face detected in the captured photo. Please retake in good lighting.",
        similarityScore: 0,
      };
    }

    const similarityScore = Math.max(0, Math.min(100, Math.round((1 - distance / 1.2) * 100)));

    if (distance <= APPROVE_DISTANCE) {
      return { status: "APPROVED" as const, reason: null, similarityScore };
    }

    if (distance <= REVIEW_DISTANCE) {
      return { status: "PENDING_REVIEW" as const, reason: "Borderline face match requires HR review", similarityScore };
    }

    return { status: "REJECTED" as const, reason: "Face does not match enrolled profile", similarityScore };
  }
}
