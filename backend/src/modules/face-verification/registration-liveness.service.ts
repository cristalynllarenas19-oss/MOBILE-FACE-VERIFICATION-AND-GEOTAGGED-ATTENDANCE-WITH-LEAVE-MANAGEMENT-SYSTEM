import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes, randomInt } from "crypto";
import * as faceapi from "face-api.js";
import { FaceVerificationService } from "./face-verification.service";

// Server-side liveness for Face Registration. The admin screen still runs
// its guided steps live, but it no longer decides the outcome: this service
// sets the steps per session (a fixed order, a random number of blinks),
// receives a key frame
// as each step happens, measures every frame itself, and only a session it
// has verified can be used to save a face profile — once.
//
// What this does and doesn't stop:
//  - A photo or a face on a phone/monitor screen, from the very first step:
//    a trained anti-spoofing model checks the first frame, the blink frames
//    and the final photo (see SPOOF_MIN_REAL_SCORE).
//  - A printed or on-screen still photo: can't blink, and tilting a flat
//    picture doesn't move the nose relative to the eyes the way a real head
//    turn does (see headYaw), so the turn steps fail.
//  - A pre-recorded video: the step order is fixed (blink, left, right) but
//    the number of blinks is random per session, so a clip recorded with
//    one blink count fails a session asking for the other.
//  - Frozen/replayed frames, a second face, or a different person partway
//    through: rejected per frame.
//  - Not guaranteed: the anti-spoofing model is a statistical classifier,
//    so a very sharp, glare-free screen or a 3D mask can still fool it, and
//    an unusual real scene (strong backlight) can occasionally score low.

export type LivenessChallenge = "blink" | "left" | "right";
export type LivenessFrameKind = "straight" | "closed" | "open" | "left" | "right" | "final";

const SESSION_TTL_MS = 3 * 60_000;
// Time the admin gets, after a verified capture, to review it and press
// Register Employee Face.
const VERIFIED_TTL_MS = 10 * 60_000;

// Same person from the last head turn to the final photo: descriptor distance
// between the two. face-api.js's usual "same person" bound is 0.6.
const SAME_PERSON_MAX_DISTANCE = 0.6;
// Head turn, in eye-distances (the admin screen asks for 0.2; a little
// slack for the key frame being taken a moment after the peak).
const TURN_MIN_YAW = 0.12;
const STRAIGHT_MAX_YAW = 0.15;
// A blink's closed frame must be this much less open than the open eyes,
// on either signal (landmark EAR or eye-opening contrast).
const CLOSED_MAX_EAR_RATIO = 0.85;
const CLOSED_MAX_CONTRAST_RATIO = 0.78;
// ...and the following open frame must recover to at least this share.
const REOPEN_MIN_RATIO = 0.85;
// Mean absolute difference (0-255) of a 32x32 grayscale thumbnail below
// which two consecutive frames count as the same, frozen image. Real camera
// noise alone is well above this.
const FROZEN_MAX_DIFF = 0.4;
const MIN_FACE_WIDTH = 100;
// A step that wasn't done well enough (a weak blink, a small turn, not
// facing forward) can be redone this many times in one session before the
// whole capture fails. Photos/screens, other faces and frozen frames still
// fail the session at once.
const MAX_STEP_RETRIES = 3;
// Anti-spoof model (see FaceVerificationService.antiSpoofRealScore): the
// lowest "real face" probability allowed on the first (Face detected) frame
// and on the final photo. Calibrated on this system's own data: registrations
// from the admin webcam scored 0.996-1.0 (the lowest, 0.475, had a bright
// window and frame edges behind the face), and a face shown on a phone held
// up to the webcam scored 0.03.
const SPOOF_MIN_REAL_SCORE = 0.3;
const SPOOF_FAILURE =
  "This looks like a photo or a phone/computer screen, not a live face. The employee must be in front of the camera in person.";

type EyeReading = { ear: number | null; eyeContrast: number | null };

type Session = {
  id: string;
  employeeId: string;
  actorUserId?: string;
  challenges: LivenessChallenge[];
  blinkCount: number;
  expected: LivenessFrameKind[];
  received: number;
  retries: number;
  expiresAt: number;
  status: "pending" | "verified" | "failed";
  reason?: string;
  busy: boolean;
  reference?: Float32Array;
  openEyes?: EyeReading;
  lastClosed?: EyeReading;
  lastThumbnail?: Float32Array;
  lastImage?: string;
  final?: { image: string; descriptor: number[] };
};

@Injectable()
export class RegistrationLivenessService {
  private readonly logger = new Logger(RegistrationLivenessService.name);
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly faceService: FaceVerificationService) {}

  createSession(employeeId: string, actorUserId?: string) {
    this.sweep();

    // Always the same order: blink, then turn left, then right. The number
    // of blinks (one or two) is random per session instead.
    const challenges: LivenessChallenge[] = ["blink", "left", "right"];
    const blinkCount = 1 + randomInt(2);

    const expected: LivenessFrameKind[] = ["straight"];
    for (const challenge of challenges) {
      if (challenge === "blink") {
        for (let i = 0; i < blinkCount; i += 1) expected.push("closed", "open");
      } else {
        expected.push(challenge);
      }
    }
    expected.push("final");

    const session: Session = {
      id: randomBytes(18).toString("base64url"),
      employeeId,
      actorUserId,
      challenges,
      blinkCount,
      expected,
      received: 0,
      retries: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
      status: "pending",
      busy: false,
    };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, challenges, blinkCount, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  async submitFrame(sessionId: string, kind: string, image: string, actorUserId?: string) {
    const session = this.sessions.get(sessionId);
    if (!session || (session.actorUserId && session.actorUserId !== actorUserId)) {
      throw new NotFoundException("Liveness session not found. Start the guided capture again.");
    }
    if (session.status !== "pending") {
      return { status: session.status, reason: session.reason ?? null };
    }
    if (Date.now() > session.expiresAt) {
      return this.fail(session, "The liveness check took too long. Please start again.");
    }
    // Frames are sent one at a time, in order; overlapping requests are a
    // client that isn't following the live camera.
    if (session.busy) {
      return this.fail(session, "Liveness frames were sent out of order. Please start again.");
    }
    const expectedKind = session.expected[session.received];
    if (kind !== expectedKind) {
      return this.fail(session, "Liveness steps were completed out of order. Please start again.");
    }

    session.busy = true;
    try {
      return await this.checkFrame(session, kind as LivenessFrameKind, image);
    } catch {
      return this.fail(session, "A camera frame couldn't be read. Please start again.");
    } finally {
      session.busy = false;
    }
  }

  // The verified capture for this employee, without using it up — so a
  // failed database save doesn't force the admin to redo the capture.
  getVerified(sessionId: string | undefined, employeeId: string, actorUserId?: string) {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (
      !session ||
      session.status !== "verified" ||
      !session.final ||
      session.employeeId !== employeeId ||
      (session.actorUserId && session.actorUserId !== actorUserId) ||
      Date.now() > session.expiresAt
    ) {
      throw new BadRequestException(
        "This face capture hasn't passed the liveness check (or it expired). Run the guided capture again.",
      );
    }
    return session.final;
  }

  consume(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  private async checkFrame(session: Session, kind: LivenessFrameKind, image: string) {
    if (image === session.lastImage) {
      return this.fail(session, "The camera image stopped updating. Please check the camera and start again.");
    }
    const base64 = image.includes("base64,") ? image.split("base64,")[1] : image;
    const buffer = Buffer.from(base64, "base64");
    // Only the last head turn gets a descriptor in the middle of the session
    // (the slowest model): it's the same-person reference the final photo is
    // checked against. The first frame keeps the fuller face search the
    // anti-spoof model was calibrated on; the final photo has its own pass,
    // which also computes the descriptor to store.
    const analysis =
      kind === "final"
        ? await this.faceService.analyzeFinalRegistrationFrame(buffer)
        : await this.faceService.analyzeRegistrationFrame(buffer, kind === "right", kind !== "straight");

    if (analysis.faceCount > 1) {
      return this.fail(session, "More than one face was in the camera. Only the employee may be visible.");
    }
    if (!analysis.face) {
      return this.retryStep(session, kind, "The face left the camera. Keep your face inside the oval.");
    }
    if (session.lastThumbnail && meanAbsDiff(session.lastThumbnail, analysis.thumbnail) < FROZEN_MAX_DIFF) {
      return this.fail(session, "The camera image stopped updating. Please check the camera and start again.");
    }

    const { face } = analysis;
    // Checked on the very first frame, so a photo or screen never gets past
    // "Face detected" — and again on the photo that will be stored.
    if (kind === "straight" || kind === "final") {
      // Logged to keep SPOOF_MIN_REAL_SCORE calibrated on real captures.
      this.logger.log(`Anti-spoof real score (${kind}): ${face.realScore.toFixed(3)}`);
    }
    if ((kind === "straight" || kind === "final") && face.realScore < SPOOF_MIN_REAL_SCORE) {
      return this.fail(session, SPOOF_FAILURE);
    }
    // Blink frames too, so a phone playing a blinking video can't be held up
    // after a real face passed the first frame. A redo rather than an instant
    // fail, as closed eyes haven't been calibrated like the frames above; a
    // video keeps failing here until the retries run out.
    if (kind === "closed" || kind === "open") {
      this.logger.log(`Anti-spoof real score (${kind}): ${face.realScore.toFixed(3)}`);
      if (face.realScore < SPOOF_MIN_REAL_SCORE) return this.retryStep(session, kind, SPOOF_FAILURE);
    }
    // The stored descriptor is computed the way attendance matching computes
    // its own (see analyzeFinalRegistrationFrame), never taken from the browser.
    const finalDescriptor = kind === "final" ? face.descriptor : null;
    const descriptor = face.descriptor;
    if (descriptor) {
      if (!session.reference) {
        session.reference = descriptor;
      } else if (faceapi.euclideanDistance(session.reference, descriptor) > SAME_PERSON_MAX_DISTANCE) {
        return this.fail(session, "A different face appeared during the liveness check. Please start again.");
      }
    }

    const eyes: EyeReading = { ear: face.ear, eyeContrast: face.eyeContrast };
    const failure = this.checkKind(session, kind, face.yaw, eyes, face.faceWidth);
    if (failure) return this.retryStep(session, kind, failure);

    session.received += 1;
    session.lastThumbnail = analysis.thumbnail;
    session.lastImage = image;

    if (finalDescriptor) {
      session.final = { image, descriptor: Array.from(finalDescriptor) };
      session.status = "verified";
      session.expiresAt = Date.now() + VERIFIED_TTL_MS;
      return { status: "verified" as const, reason: null };
    }
    return { status: "pending" as const, reason: null };
  }

  // Returns why this frame doesn't show what its step asked for, or null.
  private checkKind(
    session: Session,
    kind: LivenessFrameKind,
    yaw: number,
    eyes: EyeReading,
    faceWidth: number,
  ): string | null {
    switch (kind) {
      case "straight":
        if (Math.abs(yaw) > STRAIGHT_MAX_YAW) return "Face the camera directly.";
        session.openEyes = eyes;
        return null;
      case "closed": {
        if (Math.abs(yaw) > STRAIGHT_MAX_YAW) return "Keep facing the camera while blinking.";
        const open = session.openEyes;
        const earClosed = ratioBelow(eyes.ear, open?.ear, CLOSED_MAX_EAR_RATIO);
        const contrastClosed = ratioBelow(eyes.eyeContrast, open?.eyeContrast, CLOSED_MAX_CONTRAST_RATIO);
        if (!earClosed && !contrastClosed) return "The blink couldn't be confirmed. Blink clearly.";
        session.lastClosed = eyes;
        return null;
      }
      case "open": {
        const closed = session.lastClosed;
        const reopened =
          ratioAbove(eyes.ear, closed?.ear, 1 / REOPEN_MIN_RATIO) ||
          ratioAbove(eyes.eyeContrast, closed?.eyeContrast, 1 / REOPEN_MIN_RATIO);
        if (!reopened) return "The blink couldn't be confirmed. Blink clearly.";
        return null;
      }
      case "left":
        return yaw >= TURN_MIN_YAW ? null : "The left head turn couldn't be confirmed.";
      case "right":
        return yaw <= -TURN_MIN_YAW ? null : "The right head turn couldn't be confirmed.";
      case "final":
        if (Math.abs(yaw) > STRAIGHT_MAX_YAW) return "Face the camera directly for the photo.";
        if (faceWidth < MIN_FACE_WIDTH) return "Move closer so the face is large and clear.";
        return null;
    }
  }

  // Rewinds the session to the start of the step this frame belongs to (a
  // blink starts over from its first closed frame), so the admin screen can
  // redo just that step; the frames it already queued after this one are
  // dropped there. Past MAX_STEP_RETRIES the session fails as before.
  private retryStep(session: Session, kind: LivenessFrameKind, reason: string) {
    if (session.retries >= MAX_STEP_RETRIES) return this.fail(session, reason);
    session.retries += 1;
    const blink = kind === "closed" || kind === "open";
    session.received = session.expected.indexOf(blink ? "closed" : kind);
    session.lastClosed = undefined;
    return { status: "retry" as const, reason, step: blink ? "blink" : kind };
  }

  private fail(session: Session, reason: string) {
    session.status = "failed";
    session.reason = reason;
    return { status: "failed" as const, reason };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(id);
    }
  }
}

function meanAbsDiff(a: Float32Array, b: Float32Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// value <= reference * ratio, when both were measured.
function ratioBelow(value: number | null, reference: number | null | undefined, ratio: number) {
  return value !== null && reference != null && reference > 0 && value <= reference * ratio;
}

// value >= reference * ratio, when both were measured.
function ratioAbove(value: number | null, reference: number | null | undefined, ratio: number) {
  return value !== null && reference != null && reference > 0 && value >= reference * ratio;
}
