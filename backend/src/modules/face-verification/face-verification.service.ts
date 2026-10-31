import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as path from "path";
import * as canvasLib from "canvas";
import * as faceapi from "face-api.js";
import * as ort from "onnxruntime-node";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

const { Canvas, Image, ImageData } = canvasLib;
faceapi.env.monkeyPatch({ Canvas: Canvas as any, Image: Image as any, ImageData: ImageData as any });

const MODELS_PATH = path.join(process.cwd(), "models");

// Distance thresholds for face-api.js's 128-d face descriptors (Euclidean distance).
// Same calibration the library's own docs/examples use: <=0.45 confident match, <=0.6 borderline.
const APPROVE_DISTANCE = 0.45;
const REVIEW_DISTANCE = 0.6;

// Mean luminance (0-255) of the face region below which a frame counts as
// too dark to match reliably. Deliberately low so darker skin in ordinary
// indoor light still passes — this is only meant to catch a genuinely
// underexposed face. brightenImage()'s own target for a normal photo is 130.
const MIN_FACE_LUMINANCE = 60;

// A confident, same-day face-mismatch streak reaching this many strikes
// notifies the employee's supervisor. Chosen so isolated bad-lighting/angle
// misfires (which land as PENDING_REVIEW anyway, not this path) don't page a
// supervisor over a single attempt, while a real, repeated impersonation
// attempt still gets flagged quickly.
const MISMATCH_NOTIFY_THRESHOLD = 3;

@Injectable()
export class FaceVerificationService implements OnModuleInit {
  private readonly logger = new Logger(FaceVerificationService.name);
  private modelsLoadingPromise: Promise<void> | null = null;
  private antiSpoofLoadingPromise: Promise<{ session: ort.InferenceSession; scale: number }[]> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    await this.ensureModelsLoaded();
    // In the background, so startup isn't delayed.
    void this.warmUpModels();
  }

  // The first run of each model is about twice as slow as later ones (and
  // the anti-spoof models only load on first use), which made the first
  // guided capture after a restart sit on "Verifying liveness...". One dummy
  // pass of every model at startup takes that hit instead.
  private async warmUpModels() {
    try {
      const blank = (size: number) => canvasLib.createCanvas(size, size) as unknown as HTMLCanvasElement;
      await faceapi.detectAllFaces(blank(480), new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }));
      await faceapi.nets.faceLandmark68Net.detectLandmarks(blank(112));
      await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(blank(150));
      const models = await this.ensureAntiSpoofLoaded();
      for (const { session } of models) {
        await session.run({ input: new ort.Tensor("float32", new Float32Array(3 * 80 * 80), [1, 3, 80, 80]) });
      }
    } catch (error) {
      this.logger.warn(`Face model warm-up skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // False when the detected face is too dark for a reliable match, so the
    // scanner can hold off turning its guide green and ask for more light
    // instead of looking "all good" right before the match fails.
    wellLit: boolean;
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
        return { detected: false, confidence: 0, box: null, ear: null, wellLit: false };
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
        wellLit: this.isFaceWellLit(image, result.detection.box),
      };
    } catch (error) {
      this.logger.warn(`detectFace failed: ${error instanceof Error ? error.message : error}`);
      return { detected: false, confidence: 0, box: null, ear: null, wellLit: false };
    }
  }

  // Average brightness of just the face region (not the whole frame — a
  // bright window behind a dark face would otherwise pass). The crop is
  // drawn down to a tiny canvas first, so this adds almost nothing to the
  // per-frame cost of detectFace.
  private isFaceWellLit(image: canvasLib.Image, box: { x: number; y: number; width: number; height: number }) {
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const width = Math.min(image.width - x, box.width);
    const height = Math.min(image.height - y, box.height);
    if (width <= 0 || height <= 0) return false;

    const size = 24;
    const canvas = canvasLib.createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image as any, x, y, width, height, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (size * size) >= MIN_FACE_LUMINANCE;
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

  // One key frame of a face-registration liveness session (see
  // registration-liveness.service.ts), measured entirely here so the
  // browser's own blink/turn verdicts are never trusted. Counts every face in
  // the frame (registration needs exactly one) and, for the single face,
  // returns: eye openness two ways (landmark EAR, and the eye-opening
  // contrast the admin screen also uses because landmark eyelids often
  // barely move on a blink), head yaw, a descriptor for checking it's the
  // same person all session, and a tiny grayscale thumbnail of the whole
  // frame for spotting a frozen/repeated camera image.
  // withDescriptor: false skips the face descriptor (the slowest model, about
  // a second per frame on the server's CPU) for frames that don't need one.
  // quick: a 224 detector input (about half the time again), for the frames
  // between the first and the final one. The face fills those frames; if it
  // isn't found at 224, the frame is looked at again at 320 before counting
  // as no face.
  async analyzeRegistrationFrame(buffer: Buffer, withDescriptor = true, quick = false) {
    await this.ensureModelsLoaded();
    const image = await canvasLib.loadImage(buffer);
    // 320 rather than 416: about half the time per frame on the server's
    // CPU, with the same faces found on 480px captures.
    const detect = async (inputSize: number) => {
      const withLandmarks = faceapi
        .detectAllFaces(image as any, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.6 }))
        .withFaceLandmarks();
      const found: { landmarks: faceapi.FaceLandmarks68; detection: faceapi.FaceDetection; descriptor?: Float32Array }[] =
        withDescriptor ? await withLandmarks.withFaceDescriptors() : await withLandmarks;
      return found;
    };
    let results = await detect(quick ? 224 : 320);
    if (quick && results.length === 0) results = await detect(320);

    const thumbnail = this.grayThumbnail(image, 32);
    if (results.length !== 1) {
      return { faceCount: results.length, thumbnail, face: null };
    }

    const { landmarks, descriptor = null, detection } = results[0];
    return {
      faceCount: 1,
      thumbnail,
      face: {
        realScore: await this.antiSpoofRealScore(image, detection.box),
        ear: this.computeEyeAspectRatio(landmarks),
        eyeContrast: this.eyeContrast(image, landmarks),
        yaw: this.headYaw(landmarks),
        faceWidth: detection.box.width,
        descriptor,
      },
    };
  }

  // The final registration photo, in one pass instead of a frame check plus
  // extractDescriptor: same detector settings and tiny landmarks as
  // extractDescriptor, with its best-scoring face giving the same descriptor
  // that attendance matching computes. Only confident faces count as a second
  // person, as extractDescriptor's low threshold also finds non-faces.
  async analyzeFinalRegistrationFrame(buffer: Buffer) {
    await this.ensureModelsLoaded();
    const image = await canvasLib.loadImage(buffer);
    const results = await faceapi
      .detectAllFaces(image as any, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 }))
      .withFaceLandmarks(true)
      .withFaceDescriptors();

    const thumbnail = this.grayThumbnail(image, 32);
    if (results.length === 0) {
      return { faceCount: 0, thumbnail, face: null };
    }
    const best = results.reduce((top, result) => (result.detection.score > top.detection.score ? result : top));
    return {
      faceCount: Math.max(1, results.filter((result) => result.detection.score >= 0.6).length),
      thumbnail,
      face: {
        realScore: await this.antiSpoofRealScore(image, best.detection.box),
        ear: this.computeEyeAspectRatio(best.landmarks),
        eyeContrast: this.eyeContrast(image, best.landmarks),
        yaw: this.headYaw(best.landmarks),
        faceWidth: best.detection.box.width,
        descriptor: best.descriptor,
      },
    };
  }

  // Passive anti-spoofing (presentation-attack detection) on a single frame:
  // Minivision's Silent-Face-Anti-Spoofing MiniFASNet models (Apache-2.0,
  // ONNX exports from github.com/yakhyo/face-anti-spoofing), trained to tell a
  // live face from a printed photo or a phone/monitor screen by texture,
  // moiré, glare and screen-border cues. Two models look at two crop sizes
  // around the face (2.7x and 4x the face box) and their softmax outputs are
  // averaged, as the original project does. Class 1 is "real"; returns the
  // averaged real probability (0-1).
  async antiSpoofRealScore(image: canvasLib.Image, box: { x: number; y: number; width: number; height: number }) {
    const models = await this.ensureAntiSpoofLoaded();
    let realSum = 0;
    for (const { session, scale } of models) {
      const input = this.antiSpoofInput(image, box, scale);
      const output = await session.run({ input: new ort.Tensor("float32", input, [1, 3, 80, 80]) });
      const logits = Array.from(output.output.data as Float32Array);
      const max = Math.max(...logits);
      const exps = logits.map((v) => Math.exp(v - max));
      realSum += exps[1] / exps.reduce((sum, v) => sum + v, 0);
    }
    return realSum / models.length;
  }

  private ensureAntiSpoofLoaded() {
    if (!this.antiSpoofLoadingPromise) {
      this.antiSpoofLoadingPromise = Promise.all(
        [
          { file: "MiniFASNetV2.onnx", scale: 2.7 },
          { file: "MiniFASNetV1SE.onnx", scale: 4.0 },
        ].map(async ({ file, scale }) => ({
          session: await ort.InferenceSession.create(path.join(MODELS_PATH, file)),
          scale,
        })),
      );
    }
    return this.antiSpoofLoadingPromise;
  }

  // The models' own preprocessing: the face box grown to `scale` times its
  // size around its centre (less if the frame isn't big enough), clamped to
  // the frame, resized to 80x80, BGR channel order, raw 0-255 values, CHW.
  private antiSpoofInput(
    image: canvasLib.Image,
    box: { x: number; y: number; width: number; height: number },
    scale: number,
  ) {
    const srcW = image.width;
    const srcH = image.height;
    const s = Math.min((srcH - 1) / box.height, (srcW - 1) / box.width, scale);
    const newW = box.width * s;
    const newH = box.height * s;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const x1 = Math.max(0, Math.floor(cx - newW / 2));
    const y1 = Math.max(0, Math.floor(cy - newH / 2));
    const x2 = Math.min(srcW - 1, Math.floor(cx + newW / 2));
    const y2 = Math.min(srcH - 1, Math.floor(cy + newH / 2));

    const canvas = canvasLib.createCanvas(80, 80);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image as any, x1, y1, Math.max(1, x2 - x1 + 1), Math.max(1, y2 - y1 + 1), 0, 0, 80, 80);
    const { data } = ctx.getImageData(0, 0, 80, 80);
    const plane = 80 * 80;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i += 1) {
      input[i] = data[i * 4 + 2]; // B
      input[plane + i] = data[i * 4 + 1]; // G
      input[2 * plane + i] = data[i * 4]; // R
    }
    return input;
  }

  // Same formula as the admin screen's headYaw(): nose tip offset from the eye
  // midpoint, in eye-distances, on the raw (unmirrored) frame — positive is
  // the person's own left. A flat photo tilted or rotated in front of the
  // camera keeps this ratio roughly constant (the whole image foreshortens
  // together), so only a real 3D head turn moves it far from zero.
  private headYaw(landmarks: faceapi.FaceLandmarks68) {
    const center = (points: faceapi.Point[]) => ({
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    });
    const a = center(landmarks.getLeftEye());
    const b = center(landmarks.getRightEye());
    const eyeDistance = Math.hypot(a.x - b.x, a.y - b.y);
    if (!eyeDistance) return 0;
    return (landmarks.getNose()[3].x - (a.x + b.x) / 2) / eyeDistance;
  }

  // Port of the admin screen's eyeContrast(): average brightness of each eye
  // opening minus its darkest 20% (iris/pupil). Closing the eye covers the
  // iris with skin, so this drops sharply on a blink.
  private eyeContrast(image: canvasLib.Image, landmarks: faceapi.FaceLandmarks68): number | null {
    const center = (points: faceapi.Point[]) => ({
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    });
    const p = center(landmarks.getLeftEye());
    const q = center(landmarks.getRightEye());
    const [a, b] = p.x <= q.x ? [p, q] : [q, p];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 20) return null;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);

    const w = 24;
    const scale = w / (0.44 * d);
    const h = Math.max(5, Math.round(0.2 * d * scale));
    const canvas = canvasLib.createCanvas(w, h);
    const ctx = canvas.getContext("2d");

    let total = 0;
    for (const eye of [a, b]) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.rotate(-angle);
      ctx.translate(-eye.x, -eye.y);
      ctx.drawImage(image as any, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      const gray: number[] = [];
      for (let i = 0; i < data.length; i += 4) gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      gray.sort((x, y) => x - y);
      const darkCount = Math.max(1, Math.floor(gray.length * 0.2));
      const darkMean = gray.slice(0, darkCount).reduce((sum, v) => sum + v, 0) / darkCount;
      const mean = gray.reduce((sum, v) => sum + v, 0) / gray.length;
      total += mean - darkMean;
    }
    return total / 2;
  }

  private grayThumbnail(image: canvasLib.Image, size: number) {
    const canvas = canvasLib.createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image as any, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const gray = new Float32Array(size * size);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return gray;
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

  // Post-liveness identity check: the mobile client calls this once, on the
  // photo it just captured after blink/liveness passed, so a wrong-person
  // scan can be stopped before the user is ever shown a verified result.
  // This is NOT the authoritative decision —
  // attendance.service.ts's submit() independently re-extracts and
  // re-compares the final captured photo at submission time regardless of
  // what this endpoint returned, since a tampered client could fake this
  // response. employeeId always comes from the caller's own JWT (set by the
  // controller), never from the request body, so this can't be used to
  // probe another employee's enrolled similarity score.
  async matchEmployeeFace(employeeId: string, imageBase64: string) {
    const faceProfile = (await this.prisma.faceProfile.findFirst({
      where: { employeeId, enrollmentStatus: "ACTIVE", isArchived: false },
      orderBy: { enrolledAt: "desc" },
    })) as any;

    const enrolledDescriptor = Array.isArray(faceProfile?.descriptors) ? faceProfile.descriptors[0] : null;
    if (!enrolledDescriptor) {
      return { status: "REJECTED" as const, reason: "No active face profile is enrolled for this employee", similarityScore: 0 };
    }

    await this.ensureModelsLoaded();

    const base64Data = imageBase64.includes("base64,") ? imageBase64.split("base64,")[1] : imageBase64;
    const buffer = Buffer.from(base64Data, "base64");

    const capturedDescriptor = await this.extractDescriptor(buffer);
    const distance = capturedDescriptor ? this.compareDescriptors(enrolledDescriptor, capturedDescriptor) : null;

    const result = this.evaluateMatch(100, distance);

    // Only a confident "this is a different person" result is a face
    // mismatch for strike-counting purposes — a missing enrolled profile
    // (handled above) or no face found in the frame (distance === null,
    // its own REJECTED reason) is never the account owner's fault, and a
    // geofence failure never reaches this method at all (it's checked
    // client-side before the camera even opens, and this endpoint has no
    // location input to begin with).
    if (result.status === "REJECTED" && result.reason === "Face does not match enrolled profile") {
      await this.recordFaceMismatch(employeeId);
    }

    return result;
  }

  // Tracks same-day confident face-mismatch strikes and notifies the
  // employee's supervisor once the count reaches MISMATCH_NOTIFY_THRESHOLD
  // (not on every mismatch, and not again for the rest of that day). The
  // count resets whenever a strike lands on a day different from the one
  // last recorded, so tomorrow starts back at zero rather than staying
  // permanently maxed out.
  async recordFaceMismatch(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        userId: true,
        supervisorId: true,
        firstName: true,
        lastName: true,
        faceMismatchCount: true,
        faceMismatchCountDate: true,
      },
    });
    if (!employee) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const isSameDay = employee.faceMismatchCountDate?.getTime() === today.getTime();
    const nextCount = isSameDay ? employee.faceMismatchCount + 1 : 1;

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { faceMismatchCount: nextCount, faceMismatchCountDate: today },
    });

    if (nextCount === MISMATCH_NOTIFY_THRESHOLD) {
      await this.notifySupervisorOfMismatchStreak(employee);
    }
  }

  // Mirrors attendance.service.ts's notifyFlaggedAttempt(): a regular
  // employee's streak routes to their direct supervisor; a supervisor (or
  // an employee with no assigned supervisor) has no one above them to
  // escalate to, so it routes to HR/Admin instead.
  private async notifySupervisorOfMismatchStreak(employee: {
    userId: string;
    supervisorId: string | null;
    firstName: string;
    lastName: string;
  }) {
    const isSupervisor = await this.notifications.userHasRole(employee.userId, "SUPERVISOR");

    let recipientIds: string[];
    if (!isSupervisor && employee.supervisorId) {
      const supervisor = await this.prisma.employee.findUnique({
        where: { id: employee.supervisorId },
        select: { userId: true },
      });
      recipientIds = supervisor?.userId ? [supervisor.userId] : await this.notifications.adminUserIds();
    } else {
      recipientIds = await this.notifications.adminUserIds();
    }

    await this.notifications.notifyUsers(recipientIds, {
      title: "Repeated Face Mismatches",
      message: `${employee.firstName} ${employee.lastName}'s account has had ${MISMATCH_NOTIFY_THRESHOLD} face verification mismatches today. Please check in with them.`,
      type: "FACE_MISMATCH_STREAK",
    });
  }
}
