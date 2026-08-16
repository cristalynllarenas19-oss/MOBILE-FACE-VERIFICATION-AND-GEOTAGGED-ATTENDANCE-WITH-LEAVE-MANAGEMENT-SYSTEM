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
        // Full (non-tiny) landmark model — noticeably more accurate at
        // localizing eyelid position than the tiny variant, which is what
        // the blink-liveness check needs. The tiny model stays in use for
        // plain face tracking, where speed matters more than that precision.
        faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH),
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

  async detectFace(
    imageBase64: string,
    precise = false,
  ): Promise<{
    detected: boolean;
    confidence: number;
    box: { x: number; y: number; width: number; height: number } | null;
    // Eye-aspect-ratio for the current frame, used client-side to drive a
    // blink-based liveness check. Null whenever a face box was found but
    // landmarks couldn't be resolved for it (e.g. extreme angle/blur) — the
    // client just skips those frames rather than treating them as a blink.
    ear: number | null;
  }> {
    await this.ensureModelsLoaded();

    const base64Data = imageBase64.includes("base64,") ? imageBase64.split("base64,")[1] : imageBase64;
    const buffer = Buffer.from(base64Data, "base64");

    try {
      const image = await canvasLib.loadImage(buffer);
      // A bigger detector input gives the landmark model more pixels to
      // place the eye points on, and the full (non-tiny) landmark net
      // itself is far more accurate at eyelid position than the tiny one —
      // both matter a lot for the blink check (a couple of pixels of noise
      // is a big fraction of an eye's height) but aren't worth the extra
      // latency for plain face tracking, which only needs a box.
      const result = await faceapi
        .detectSingleFace(
          image as any,
          new faceapi.TinyFaceDetectorOptions({ inputSize: precise ? 288 : 192, scoreThreshold: 0.45 }),
        )
        .withFaceLandmarks(!precise);

      if (!result) {
        return { detected: false, confidence: 0, box: null, ear: null };
      }

      // Box coordinates as fractions (0-1) of the source image, so the
      // mobile client can map them onto its own preview size without
      // needing to know the exact pixel dimensions we decoded here.
      const relativeBox = result.detection.relativeBox;
      const ear = this.computeEyeAspectRatio(result.landmarks);
      // Temporary while diagnosing the blink check: confirms, from the
      // server's own terminal, which model this request actually used and
      // what it computed — independent of anything the client reports.
      // .log (not .debug) so this is visible regardless of configured log
      // levels — Nest's default logger has "debug" disabled out of the box.
      this.logger.log(
        `detectFace precise=${precise} model=${precise ? "faceLandmark68Net" : "faceLandmark68TinyNet"} ear=${ear === null ? "null" : ear.toFixed(3)}`,
      );
      return {
        detected: true,
        confidence: result.detection.score,
        box: { x: relativeBox.x, y: relativeBox.y, width: relativeBox.width, height: relativeBox.height },
        ear,
      };
    } catch (error) {
      this.logger.warn(`detectFace failed: ${error instanceof Error ? error.message : error}`);
      return { detected: false, confidence: 0, box: null, ear: null };
    }
  }

  // Eye-aspect-ratio (Soukupova & Cech): stays roughly constant while an eye
  // is open and drops sharply while closed, which is what lets the client
  // tell an open/closed transition apart from a raw jpeg's noise.
  private computeEyeAspectRatio(landmarks: faceapi.FaceLandmarks68): number | null {
    const eyeRatio = (eye: faceapi.Point[]) => {
      const dist = (a: faceapi.Point, b: faceapi.Point) => Math.hypot(a.x - b.x, a.y - b.y);
      const width = dist(eye[0], eye[3]);
      if (!width) return null;
      return (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * width);
    };

    const left = eyeRatio(landmarks.getLeftEye());
    const right = eyeRatio(landmarks.getRightEye());
    if (left === null || right === null) return null;
    return (left + right) / 2;
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

  // Front-camera selfies taken indoors with no flash are routinely
  // underexposed, which both looks bad in the stored photo and starves
  // face-api.js of contrast/detail it needs for an accurate descriptor
  // (a likely cause of "can't recognize me" false rejections). This
  // auto-levels the image using its own histogram: the 1st-99th percentile
  // range is stretched to fill 0-255, and only if the photo is still dark
  // on average after that (a genuinely underexposed shot, not just one
  // lacking pure blacks/whites) is an extra midtone lift applied — so a
  // normally-lit photo is left close to untouched while a dark one gets a
  // real boost. Re-encodes as the buffer used for both matching and storage.
  async brightenImage(buffer: Buffer): Promise<{ buffer: Buffer; data: string; mimeType: string }> {
    const image = await canvasLib.loadImage(buffer);
    const canvas = canvasLib.createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image as any, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;
    const pixelCount = data.length / 4;

    const luminanceOf = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    const histogram = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      histogram[Math.round(luminanceOf(i))]++;
    }

    const clip = pixelCount * 0.01;

    let low = 0;
    let cumulative = 0;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= clip) {
        low = i;
        break;
      }
    }

    let high = 255;
    cumulative = 0;
    for (let i = 255; i >= 0; i--) {
      cumulative += histogram[i];
      if (cumulative >= clip) {
        high = i;
        break;
      }
    }

    const range = high - low;
    if (range > 10) {
      for (let i = 0; i < data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
          data[i + channel] = Math.max(0, Math.min(255, Math.round(((data[i + channel] - low) / range) * 255)));
        }
      }

      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += luminanceOf(i);
      }
      const meanLuminance = sum / pixelCount;
      const targetLuminance = 130;

      if (meanLuminance > 0 && meanLuminance < targetLuminance) {
        const gamma = Math.max(0.55, Math.log(targetLuminance / 255) / Math.log(meanLuminance / 255));
        for (let i = 0; i < data.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) {
            data[i + channel] = Math.round(255 * Math.pow(data[i + channel] / 255, gamma));
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);
    }

    const out = canvas.toBuffer("image/jpeg", { quality: 0.92 });
    return { buffer: out, data: out.toString("base64"), mimeType: "image/jpeg" };
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
