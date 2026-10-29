import * as faceapi from "face-api.js";
import { AlertTriangle, Archive, Briefcase, Building2, Calendar, Camera, Check, CheckCircle2, ChevronLeft, ChevronRight, Eye, Fingerprint, Mail, MapPin, Network, RefreshCw, RotateCcw, ScanFace, Search, User, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../lib/api";
import { useLiveRefresh } from "../../lib/liveRefresh";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { Badge } from "../../components/ui/Badge";
import { useActiveDepartments } from "../../lib/departments";
import { formatAttendanceMode, useAttendanceModeOptions } from "../../lib/attendanceModes";
import { EMPLOYMENT_STATUS_LABELS, formatEmploymentStatus } from "../../types/employment";
import "./FaceRegistrationPage.css";

type Enrollment = {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  department: string;
  referenceImage: string;
  descriptors: number[][];
  sampleCount: number;
  createdAt: string;
};

type FaceFrame = {
  width: number;
  height: number;
  x: number;
  y: number;
  boxWidth: number;
  boxHeight: number;
  // Whether the face is positioned/sized well enough and confident enough to
  // actually pass detectFace()'s own capture checks right now — drives the
  // face oval's outline turning green.
  ready: boolean;
  // Face centre inside the on-screen oval (see isFaceInOval).
  inOval: boolean;
};

export type FaceRegistrationEmployee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  department?: { name: string } | null;
  // Details captured on the Add Employee form; present when the employee is
  // handed over from Employee Management so the panel can recap them.
  user?: { email: string } | null;
  supervisor?: { firstName: string; lastName: string } | null;
  hireDate?: string;
  employmentStatus?: "REGULAR" | "PROBATIONARY" | "PERMANENT_SEASONAL" | "PROBATIONARY_SEASONAL" | "SEPARATED";
  attendanceMode?: string;
  sex?: "MALE" | "FEMALE" | null;
  soloParentStatus?: "NOT_APPLICABLE" | "ELIGIBLE" | "INELIGIBLE";
  // Null until the employee accepts the face-data consent from the mobile
  // app's FaceConsentScreen. Only meaningful when requiresFaceConsent is
  // true — see the consent-required modal below.
  faceConsentAcceptedAt?: string | null;
  // False for employees that already existed before the face-consent
  // feature shipped (grandfathered in via a one-time backfill) — only
  // employees added afterward are blocked from Face Registration pending
  // consent.
  requiresFaceConsent?: boolean;
};

type Employee = FaceRegistrationEmployee;

type FaceProfile = {
  id: string;
  employeeId: string;
  referenceImageData: string | null;
  enrollmentStatus: "PENDING" | "ACTIVE" | "REJECTED";
  enrolledAt: string | null;
  isArchived?: boolean;
  employee: Employee;
};

const MODEL_URL = "/models";
const CAMERA_SAMPLE_TARGET = 1;

function employeeLabel(employee: Employee) {
  return `${employee.firstName} ${employee.lastName}`;
}

// face-api.js ships no eyewear classifier, so this is a pixel check built on
// the 68-point landmarks we already compute. It only looks for things a bare
// face can't produce, so ordinary eye features (iris vs. white of the eye,
// lashes, brows) and lighting (shadowed eye sockets under a ceiling light)
// don't count:
//  1. The bridge. Every pair of glasses — rimmed, rimless, wire, sunglasses —
//     has a bar crossing the top of the nose between the eyes. In that small
//     patch of skin (well clear of the eyes and brows) we look for a thin
//     horizontal bar spanning most of its width: an edge of one polarity with
//     the opposite edge just below it. A shadow boundary is a single edge, and
//     the sides of the nose are vertical, so neither qualifies.
//  2. Dark, flat lenses (sunglasses): both eye openings much darker than the
//     cheek below them AND without the bright-white/dark-iris contrast a
//     visible eye always has.
// Regions are placed relative to the two eye centres and sampled with the eye
// line rotated level, so face size, distance and head tilt don't matter.
// The verdict is a majority over the last EYEWEAR_WINDOW polls (~2s), never a
// single frame, so a passing shadow or blink can't flip it.
const EYEWEAR_WINDOW = 8;
const EYEWEAR_MIN_POSITIVES = 6;

function isEyewearConfirmed(history: boolean[]) {
  return history.filter(Boolean).length >= EYEWEAR_MIN_POSITIVES;
}
// Below this distance between the eye centres (video pixels) the face is too
// small for the bridge to be resolved, so no verdict is given.
const EYEWEAR_MIN_EYE_DISTANCE = 36;
// Bridge bar: edge strength relative to the patch's own contrast (lighting
// independent), the share of the patch width the bar must span, and how far
// apart (as a share of patch height) its two edges may be.
const BRIDGE_MIN_CONTRAST = 18;
const BRIDGE_EDGE_FACTOR = 1.2;
const BRIDGE_MIN_EDGE = 30;
const BRIDGE_MIN_COVERAGE = 0.75;
const BRIDGE_MAX_BAR_HEIGHT = 0.35;
// Sunglasses: eye opening at most this share of the cheek's brightness, with
// less than this much brightness spread (std dev, 0-255) inside it.
const SUNGLASSES_MAX_BRIGHTNESS_RATIO = 0.55;
const SUNGLASSES_MAX_EYE_SPREAD = 22;
const ENROLLMENTS_PAGE_SIZE = 5;

type Point = { x: number; y: number };
type FaceAxes = { left: Point; right: Point; mid: Point; angle: number; d: number };

function centerOf(points: faceapi.Point[]): Point {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

function faceAxes(landmarks: faceapi.FaceLandmarks68): FaceAxes | null {
  const a = centerOf(landmarks.getLeftEye());
  const b = centerOf(landmarks.getRightEye());
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const d = Math.hypot(right.x - left.x, right.y - left.y);
  if (d < EYEWEAR_MIN_EYE_DISTANCE) return null;
  return {
    left,
    right,
    mid: { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 },
    angle: Math.atan2(right.y - left.y, right.x - left.x),
    d,
  };
}

let samplingCanvas: HTMLCanvasElement | null = null;

// Grayscale copy of a rectangle centred (u, v) eye-distances from `origin` —
// u along the eye line, v down the face — of half-size halfW x halfH, rotated
// level and scaled to outWidth pixels wide.
function sampleRegion(
  video: HTMLVideoElement,
  axes: FaceAxes,
  origin: Point,
  u: number,
  v: number,
  halfW: number,
  halfH: number,
  outWidth: number,
) {
  const cos = Math.cos(axes.angle);
  const sin = Math.sin(axes.angle);
  const cx = origin.x + (u * cos - v * sin) * axes.d;
  const cy = origin.y + (u * sin + v * cos) * axes.d;
  const scale = outWidth / (halfW * 2 * axes.d);
  const w = outWidth;
  const h = Math.max(5, Math.round(halfH * 2 * axes.d * scale));

  samplingCanvas ??= document.createElement("canvas");
  samplingCanvas.width = w;
  samplingCanvas.height = h;
  const ctx = samplingCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);
  ctx.rotate(-axes.angle);
  ctx.translate(-cx, -cy);
  ctx.drawImage(video, 0, 0);

  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return { gray, w, h };
}

function boxBlur(gray: Float32Array, w: number, h: number) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) {
            sum += gray[yy * w + xx];
            count++;
          }
        }
      }
      out[y * w + x] = sum / count;
    }
  }
  return out;
}

function percentile(values: Float32Array, p: number) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// Signal 1 — see the comment above EYEWEAR_WINDOW.
function hasBridgeBar(video: HTMLVideoElement, axes: FaceAxes) {
  // Between the inner eye corners (~±0.28 eye-distances from the midpoint),
  // from eye level up to just under the brows (which start ~0.3 above it) —
  // the strip of nose skin a bridge always crosses. Kept clear of the brows
  // so thick or joined eyebrows can't pass for a bar.
  const region = sampleRegion(video, axes, axes.mid, 0, -0.05, 0.15, 0.17, 32);
  if (!region) return false;
  const { w, h } = region;
  const gray = boxBlur(region.gray, w, h);

  const contrast = percentile(gray, 0.95) - percentile(gray, 0.05);
  if (contrast < BRIDGE_MIN_CONTRAST) return false;
  const threshold = Math.max(BRIDGE_MIN_EDGE, contrast * BRIDGE_EDGE_FACTOR);

  // Per row: which columns have a strong, mostly-horizontal edge going
  // darker-downward (+1) or lighter-downward (-1).
  const signs = new Int8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const at = (dx: number, dy: number) => gray[(y + dy) * w + (x + dx)];
      const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      if (Math.abs(gy) > threshold && Math.abs(gy) > 1.5 * Math.abs(gx)) {
        signs[y * w + x] = gy > 0 ? 1 : -1;
      }
    }
  }

  // Share of the width covered by each polarity around each row (±1 row, so
  // a slightly curved bar still counts).
  const coverage = (row: number, sign: number) => {
    let hit = 0;
    for (let x = 1; x < w - 1; x++) {
      for (let y = Math.max(1, row - 1); y <= Math.min(h - 2, row + 1); y++) {
        if (signs[y * w + x] === sign) {
          hit++;
          break;
        }
      }
    }
    return hit / (w - 2);
  };

  const maxGap = Math.max(2, Math.round(h * BRIDGE_MAX_BAR_HEIGHT));
  for (let top = 1; top < h - 1; top++) {
    for (const sign of [1, -1]) {
      if (coverage(top, sign) < BRIDGE_MIN_COVERAGE) continue;
      for (let bottom = top + 1; bottom <= Math.min(h - 2, top + maxGap); bottom++) {
        if (coverage(bottom, -sign) >= BRIDGE_MIN_COVERAGE) return true;
      }
    }
  }
  return false;
}

function meanAndSpread(gray: Float32Array) {
  const mean = gray.reduce((sum, value) => sum + value, 0) / gray.length;
  const variance = gray.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gray.length;
  return { mean, spread: Math.sqrt(variance) };
}

// Signal 2 — dark, flat lenses over both eyes.
function hasDarkLenses(video: HTMLVideoElement, axes: FaceAxes) {
  return [axes.left, axes.right].every((eye) => {
    const opening = sampleRegion(video, axes, eye, 0, 0, 0.2, 0.08, 24);
    const cheek = sampleRegion(video, axes, eye, 0, 0.62, 0.15, 0.08, 16);
    if (!opening || !cheek) return false;
    const eyeStats = meanAndSpread(opening.gray);
    const cheekStats = meanAndSpread(cheek.gray);
    return (
      eyeStats.mean < cheekStats.mean * SUNGLASSES_MAX_BRIGHTNESS_RATIO &&
      eyeStats.spread < SUNGLASSES_MAX_EYE_SPREAD
    );
  });
}

function detectEyewear(video: HTMLVideoElement, landmarks: faceapi.FaceLandmarks68): boolean {
  const axes = faceAxes(landmarks);
  if (!axes) return false;
  return hasBridgeBar(video, axes) || hasDarkLenses(video, axes);
}

// ── Guided movements (active liveness) ───────────────────────────────────
// Start guided capture walks the employee through these steps, each judged
// live from the tracker's own landmarks. The ticks on screen only guide the
// employee — they are NOT the verdict: the backend picks the step order and
// blink count at random per session, receives a key frame as each step
// happens, and measures those frames itself (see the backend's
// registration-liveness.service.ts). Only a session the backend verified can
// be registered. This stops held-up photos and simple video replays; it is
// not proof against a live video call or a deepfake.
type LivenessStepKey = "straight" | "blink" | "left" | "right" | "center";
type LivenessChallenge = "blink" | "left" | "right";
type LivenessStep = {
  key: LivenessStepKey;
  group: number;
  sub: string;
  instruction: string;
  passed: string;
  timeout: string;
};

const LIVENESS_STEP_TEXT: Record<LivenessStepKey, Omit<LivenessStep, "key" | "group">> = {
  straight: {
    sub: "Make sure your face is centered and clearly visible.",
    instruction: "Look straight at the camera.",
    passed: "Face position confirmed",
    timeout: "Couldn't confirm a straight, centered face.",
  },
  blink: {
    sub: "Close and open your eyes once.",
    instruction: "Please blink naturally.",
    passed: "Blink detected",
    timeout: "No blink was detected.",
  },
  left: {
    sub: "Turn until the step is checked, then face forward.",
    instruction: "Slowly turn your head to the left.",
    passed: "Left turn detected",
    timeout: "No turn to the left was detected.",
  },
  right: {
    sub: "Turn until the step is checked, then face forward.",
    instruction: "Slowly turn your head to the right.",
    passed: "Right turn detected",
    timeout: "No turn to the right was detected.",
  },
  center: {
    sub: "Taking your photo...",
    instruction: "Hold still.",
    passed: "Photo captured",
    timeout: "Couldn't confirm a straight, centered face.",
  },
};

// The steps in the order the backend chose: face check, the challenges
// (blink and the two turns, in random order), then the photo. The step bar
// keeps its four groups — both turns fall under "Turn head" — with Blink and
// Turn head swapping places when the turns come first.
function buildLivenessSteps(challenges: LivenessChallenge[], blinkCount: number): LivenessStep[] {
  const blinkFirst = challenges[0] === "blink";
  const step = (key: LivenessStepKey, group: number): LivenessStep => {
    const text = LIVENESS_STEP_TEXT[key];
    if (key === "blink" && blinkCount > 1) {
      return { key, group, ...text, sub: "Close and open your eyes twice.", instruction: "Please blink twice." };
    }
    return { key, group, ...text };
  };
  return [
    step("straight", 0),
    ...challenges.map((key) => step(key, key === "blink" ? (blinkFirst ? 1 : 2) : blinkFirst ? 2 : 1)),
    step("center", 3),
  ];
}

const DEFAULT_LIVENESS_STEPS = buildLivenessSteps(["blink", "left", "right"], 1);

function livenessGroupLabels(steps: LivenessStep[]) {
  const blinkFirst = steps[1]?.key === "blink";
  return ["Face detected", blinkFirst ? "Blink" : "Turn head", blinkFirst ? "Turn head" : "Blink", "Capture"];
}

type LivenessFrameResult = { status: "pending" | "verified" | "failed"; reason: string | null };

// The longest the final verification may take after the photo before the
// attempt counts as failed (the server measures every frame it received).
const LIVENESS_VERIFY_TIMEOUT_MS = 60_000;
const LIVE_FACE_CHECK_HINT = "Checking for a live face...";

// The face oval's outline in an 80x100 box: top → right → bottom → left →
// top (two clockwise half-arcs), so the progress ring fills from the top.
const FACE_OVAL_PATH = "M 40 1.5 A 38.5 48.5 0 1 1 40 98.5 A 38.5 48.5 0 1 1 40 1.5";

// Tracker poll rate: the usual 4/s, and 10/s while the steps run so a short
// blink isn't missed. Back to 4/s as soon as the steps end.
const FACE_TRACKING_MS = 250;
const LIVENESS_TRACKING_MS = 100;
const LIVENESS_STEP_TIMEOUT_MS = 12_000;
// How long the face must stay straight and centered to pass a "look
// straight" step, and how long each step's tick is shown before the next.
const LIVENESS_HOLD_MS = 800;
// The final photo step: the face was just confirmed facing forward, so a
// shorter hold is enough.
const LIVENESS_CAPTURE_HOLD_MS = 500;
const LIVENESS_PASS_PAUSE_MS = 600;
// After the photo: long enough to see the flash and "Photo captured".
const LIVENESS_CAPTURED_PAUSE_MS = 800;
// Head turn: nose tip offset from the eye midpoint, in eye-distances.
// ~0 facing the camera; past TURN counts as a turn, within STRAIGHT as straight.
const YAW_STRAIGHT = 0.1;
const YAW_TURN = 0.2;
// Blink: eye openness relative to this employee's own open eyes (tracked
// during the blink step), so eye shape doesn't matter.
const BLINK_CLOSED_RATIO = 0.78;
const BLINK_OPEN_RATIO = 0.9;
// Same, for the eye-contrast signal (see eyeContrast), sampled this often.
const BLINK_CONTRAST_CLOSED_RATIO = 0.7;
const BLINK_CONTRAST_OPEN_RATIO = 0.88;
const BLINK_SAMPLE_MS = 33;
// A blink only counts with the head still and facing forward: at most this
// much turn, this much shift between detections (in eye-distances), and
// eye positions at most this old for the fast sampler.
const YAW_BLINK_MAX = 0.14;
const BLINK_MAX_HEAD_SHIFT = 0.12;
const BLINK_EYES_MAX_AGE_MS = 250;
// How far the face centre may sit from the oval's centre, as a share of the
// oval's half-size, and still count as inside it.
const FACE_IN_OVAL_MAX = 0.42;
// Mean brightness (0-255) of the face below which lighting is too dark.
const MIN_FACE_BRIGHTNESS = 55;

type TrackedFace = {
  video: HTMLVideoElement;
  landmarks: faceapi.FaceLandmarks68;
  box: faceapi.Box;
  score: number;
};

class LivenessCancelled extends Error {}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Eye aspect ratio: eyelid opening over eye width, from the 6 points of
// each eye (p1/p4 corners, p2/p3 upper lid, p6/p5 lower lid). Drops sharply
// while the eye is closed.
function eyeAspectRatio(eye: faceapi.Point[]) {
  const [p1, p2, p3, p4, p5, p6] = eye;
  return (distance(p2, p6) + distance(p3, p5)) / (2 * distance(p1, p4));
}

function eyeOpenness(landmarks: faceapi.FaceLandmarks68) {
  return (eyeAspectRatio(landmarks.getLeftEye()) + eyeAspectRatio(landmarks.getRightEye())) / 2;
}

// In the raw (unmirrored) camera frame the employee's own left is the image's
// right, so turning to their left moves the nose tip right: positive = their
// left, negative = their right. Matches what they see in the mirrored preview.
function headYaw(landmarks: faceapi.FaceLandmarks68) {
  const a = centerOf(landmarks.getLeftEye());
  const b = centerOf(landmarks.getRightEye());
  const eyeDistance = distance(a, b);
  if (eyeDistance === 0) return 0;
  const noseTip = landmarks.getNose()[3];
  return (noseTip.x - (a.x + b.x) / 2) / eyeDistance;
}

function faceBrightness(video: HTMLVideoElement, box: faceapi.Box) {
  samplingCanvas ??= document.createElement("canvas");
  samplingCanvas.width = 24;
  samplingCanvas.height = 24;
  const ctx = samplingCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 255;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, 24, 24);
  const { data } = ctx.getImageData(0, 0, 24, 24);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (data.length / 4);
}

// Positioning guidance shown under the current step; "" when the face is
// well placed. Uses the same size rule as the capture itself.
const FACE_OUTSIDE_OVAL_HINT = "Please move your face inside the oval.";

function getPositionHint(face: TrackedFace | null, eyewear: boolean, inOval: boolean) {
  if (!face) return "No face detected. Face the camera.";
  if (!inOval) return FACE_OUTSIDE_OVAL_HINT;
  if (eyewear) return "Remove eyeglasses or sunglasses.";
  const { video, box } = face;
  if (box.width < 120 || box.height < 120) return "Move closer to the camera.";
  if (faceBrightness(video, box) < MIN_FACE_BRIGHTNESS) return "Too dark. Improve the lighting.";
  return "";
}

// Whether the detected face's centre sits inside the on-screen oval — checked
// against the oval's real position, mapping the face from raw video pixels
// to the mirrored, cover-cropped preview the employee sees.
function isFaceInOval(oval: HTMLElement | null, video: HTMLVideoElement, box: faceapi.Box) {
  if (!oval || !video.videoWidth || !video.videoHeight) return true;
  const o = oval.getBoundingClientRect();
  const v = video.getBoundingClientRect();
  if (!o.width || !o.height) return true;
  const scale = Math.max(v.width / video.videoWidth, v.height / video.videoHeight);
  const cropX = (video.videoWidth * scale - v.width) / 2;
  const cropY = (video.videoHeight * scale - v.height) / 2;
  const shownX = (box.x + box.width / 2) * scale - cropX;
  const centerX = v.left + (v.width - shownX);
  const centerY = v.top + (box.y + box.height / 2) * scale - cropY;
  const nx = (centerX - (o.left + o.width / 2)) / (o.width / 2);
  const ny = (centerY - (o.top + o.height / 2)) / (o.height / 2);
  return nx * nx + ny * ny <= FACE_IN_OVAL_MAX * FACE_IN_OVAL_MAX;
}

// Second blink signal, independent of the landmark eyelid points (which
// often barely close on a blink): the contrast inside each eye opening —
// average brightness minus its darkest pixels (iris/pupil). Closing the eye
// covers the iris with skin, so it drops sharply. Cheap enough to sample
// every animation frame, so a quick blink isn't missed between detections.
function eyeContrast(video: HTMLVideoElement, axes: FaceAxes) {
  let total = 0;
  for (const eye of [axes.left, axes.right]) {
    const region = sampleRegion(video, axes, eye, 0, 0, 0.22, 0.1, 24);
    if (!region) return null;
    const sorted = Array.from(region.gray).sort((a, b) => a - b);
    const darkCount = Math.max(1, Math.floor(sorted.length * 0.2));
    const darkMean = sorted.slice(0, darkCount).reduce((sum, value) => sum + value, 0) / darkCount;
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    total += mean - darkMean;
  }
  return total / 2;
}

// Open → closed → open on one signal, measured against that signal's own
// open-eye level (followed while the eyes are open, so it suits the person
// and the lighting). Returns true once a full blink is seen. onClosed gets
// each closed-eye reading (lower = more closed), so the caller can keep the
// most-closed frame to send to the backend.
function createBlinkDetector(closedRatio: number, openRatio: number, onClosed?: (closedness: number) => void) {
  let reference: number | null = null;
  let sawOpen = false;
  let sawClosed = false;
  return (value: number) => {
    if (value <= 0) return false;
    reference ??= value;
    const ratio = value / reference;
    if (ratio >= openRatio) {
      if (sawOpen && sawClosed) return true;
      sawOpen = true;
      reference = reference * 0.8 + value * 0.2;
    } else if (ratio <= closedRatio && sawOpen) {
      sawClosed = true;
      onClosed?.(ratio / closedRatio);
    }
    return false;
  };
}

// The first run of a model in the browser is slow (its GPU programs get
// built then), and the capture is the only place the face-signature model and
// the 416px detector run — so without this the "Hold still" step stalls for
// seconds the first time. Runs both once on a blank image right after the
// models load, in the background; any failure just means no head start.
function warmUpCaptureModels() {
  window.setTimeout(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 150;
    canvas.height = 150;
    Promise.all([
      faceapi.nets.faceRecognitionNet.computeFaceDescriptor(canvas),
      faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.65 })),
    ]).catch(() => undefined);
  }, 300);
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function FaceRegistrationPage({ initialEmployee }: { initialEmployee?: FaceRegistrationEmployee } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(false);
  const faceTrackingTimerRef = useRef<number | null>(null);
  // Eyewear verdicts of the most recent polls — see EYEWEAR_WINDOW.
  const eyewearHistoryRef = useRef<boolean[]>([]);
  // Guided movements: the tracker hands each frame to the running step via
  // livenessListenerRef; livenessAbortRef stops it (Reset, camera stopped).
  // Steps already passed this camera session are kept so a failed step can
  // be retried on its own.
  const trackingRateRef = useRef(FACE_TRACKING_MS);
  const trackingInFlightRef = useRef(false);
  const livenessListenerRef = useRef<((face: TrackedFace | null) => void) | null>(null);
  const livenessAbortRef = useRef<(() => void) | null>(null);
  const fullLandmarksReadyRef = useRef(false);
  // The backend liveness session of the running guided capture. Key frames
  // are uploaded one at a time, in order, through frameChainRef; the first
  // rejection is kept in `failure` and ends the attempt.
  const livenessSessionRef = useRef<{ id: string; blinkCount: number; failure: string | null; verified: boolean } | null>(
    null,
  );
  const frameChainRef = useRef<Promise<void>>(Promise.resolve());
  const [livenessSteps, setLivenessSteps] = useState<LivenessStep[]>(DEFAULT_LIVENESS_STEPS);
  // Set only once the backend has verified the capture; Register Employee
  // Face stays disabled until then, and it's what the save sends.
  const [verifiedSessionId, setVerifiedSessionId] = useState<string | null>(null);
  // Photo taken; waiting for the backend's verdict on the frames.
  const [livenessVerifying, setLivenessVerifying] = useState(false);
  // The on-screen oval, for checking the face is inside it.
  const faceOvalRef = useRef<HTMLDivElement>(null);
  const [liveness, setLiveness] = useState<{
    step: number;
    status: "active" | "passed" | "failed";
    // Why the step failed (a timeout, or the capture's own check).
    reason?: string;
  } | null>(null);
  const [livenessHint, setLivenessHint] = useState("");
  // The head turned the opposite way from the current turn step.
  const [livenessWrongWay, setLivenessWrongWay] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  // A just-created employee handed over from Employee Management arrives
  // pre-selected so the admin can go straight to the camera capture. Until
  // their face is registered the page stays locked to them — no search UI.
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(initialEmployee ?? null);
  const [handoffCompleted, setHandoffCompleted] = useState(false);
  const [descriptors, setDescriptors] = useState<number[][]>([]);
  const [preview, setPreview] = useState("");
  const [enrollments, setEnrollments] = useState<FaceProfile[]>([]);
  const [message, setMessage] = useState("Loading face recognition models...");
  const [busy, setBusy] = useState(false);
  const [faceFrame, setFaceFrame] = useState<FaceFrame | null>(null);
  const [eyewearDetected, setEyewearDetected] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showCapturePreview, setShowCapturePreview] = useState(false);
  const [lastRegisteredEmployee, setLastRegisteredEmployee] = useState<Employee | null>(null);
  const [lastActionWasEdit, setLastActionWasEdit] = useState(false);
  const [listDepartmentFilter, setListDepartmentFilter] = useState<string>("ALL");
  const [listModeFilter, setListModeFilter] = useState<"ALL" | "FIELD" | "FIXED" | "ARCHIVED">("ALL");
  const [listSearch, setListSearch] = useState("");
  const [enrollmentsPage, setEnrollmentsPage] = useState(1);
  const [viewProfile, setViewProfile] = useState<FaceProfile | null>(null);
  // Every employee, for the "Awaiting face registration" list — read from the
  // database each time (so batch-imported employees appear too), never from
  // a list of just-added employees.
  const [allEmployees, setAllEmployees] = useState<Employee[]>([]);
  const [awaitingDepartmentFilter, setAwaitingDepartmentFilter] = useState("ALL");
  // A face photo opened full size (click it again, or anywhere, to close).
  const [enlargedPhoto, setEnlargedPhoto] = useState<string | null>(null);
  const [editingEnrollmentId, setEditingEnrollmentId] = useState<string | null>(null);
  const captureCardRef = useRef<HTMLDivElement>(null);
  const [archiveTarget, setArchiveTarget] = useState<FaceProfile | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [consentRefreshing, setConsentRefreshing] = useState(false);
  // Employee whose consent modal the admin closed with X — only hides the
  // modal so the admin can move on (e.g. add another employee); consent
  // stays pending and registration stays blocked.
  const [consentDismissedFor, setConsentDismissedFor] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiRequest<FaceProfile[]>("/face-profiles?includeArchived=true"),
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
      .then(([faceProfiles]) => {
        // Archived (SEPARATED) employees are managed from Employee Management →
        // Archived Employees only; their face records stay in the database.
        setEnrollments(faceProfiles.filter((item) => item.employee.employmentStatus !== "SEPARATED"));
        setModelsReady(true);
        warmUpCaptureModels();
        setMessage(
          initialEmployee
            ? faceProfiles.some((item) => item.employeeId === initialEmployee.id)
              ? `Start the camera to register ${employeeLabel(initialEmployee)}'s face.`
              : `Employee added successfully. Start the camera to register ${employeeLabel(initialEmployee)}'s face.`
            : "",
        );
      })
      .catch(() => setMessage("Employee or face models could not be loaded. Refresh the page and try again."));

    // Full 68-point landmark model, used only while the guided movements
    // run: the tiny model's eyelid points barely move on a blink. Optional —
    // if it fails to load the steps fall back to the tiny model.
    faceapi.nets.faceLandmark68Net
      .loadFromUri(MODEL_URL)
      .then(() => {
        fullLandmarksReadyRef.current = true;
      })
      .catch(() => undefined);

    return () => {
      stopFaceTracking();
      stopCamera();
    };
  }, []);

  useEffect(() => {
    if (cameraActive && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      startFaceTracking();
    }
    if (!cameraActive) {
      stopFaceTracking();
    }
  }, [cameraActive, modelsReady]);

  async function startCamera() {
    if (!modelsReady) return;
    // A capture always belongs to an employee — nothing to register it to otherwise.
    if (!selectedEmployee) {
      setMessage("Select an employee first.");
      return;
    }
    if (selectedEmployee?.requiresFaceConsent && !selectedEmployee.faceConsentAcceptedAt) return;
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      // Camera unplugged, or access revoked mid-capture: end safely.
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          if (streamRef.current !== stream) return;
          stopCamera();
          setMessage("The camera was disconnected. Start the camera and try again.");
        };
      });
      clearLiveness();
      setVerifiedSessionId(null);
      setCameraActive(true);
      setDescriptors([]);
      setPreview("");
      setFaceFrame(null);
      setEyewearDetected(false);
    } catch {
      setMessage("Camera access was denied or no camera is available.");
    }
  }

  // Ends any running step and its backend session — used whenever the
  // camera session ends or the capture is reset. (A verified capture
  // waiting to be registered is kept; see verifiedSessionId.)
  function clearLiveness() {
    livenessAbortRef.current?.();
    livenessSessionRef.current = null;
    setLivenessVerifying(false);
    setFaceTrackingRate(FACE_TRACKING_MS);
    setLiveness(null);
    setLivenessHint("");
    setLivenessWrongWay(false);
  }

  function stopCamera() {
    sequenceRef.current = false;
    clearLiveness();
    stopFaceTracking();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
    setBusy(false);
    setFaceFrame(null);
    setEyewearDetected(false);
  }

  async function detectFace(input: HTMLVideoElement | HTMLImageElement) {
    const results = await faceapi
      .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.65 }))
      .withFaceLandmarks(true)
      .withFaceDescriptors();

    if (results.length !== 1) {
      throw new Error(results.length === 0 ? "No face detected. Improve lighting and face the camera." : "Multiple faces detected. Only one person may be visible.");
    }

    const box = results[0].detection.box;
    if (box.width < 120 || box.height < 120) {
      throw new Error("Move closer so the face is large and clear.");
    }
    // The live tracker already blocks starting a guided capture while eyewear
    // is confirmed; re-check its (multi-frame) verdict at the moment of
    // capture, rather than judging this one frame on its own.
    if (input instanceof HTMLVideoElement && isEyewearConfirmed(eyewearHistoryRef.current)) {
      throw new Error("Eyeglasses or sunglasses detected. Please remove them and try again.");
    }
    return Array.from(results[0].descriptor);
  }

  // keepHistory: a rate change mid-session keeps the eyewear verdicts so far.
  function startFaceTracking(keepHistory = false) {
    if (!modelsReady || faceTrackingTimerRef.current) return;
    if (!keepHistory) eyewearHistoryRef.current = [];

    faceTrackingTimerRef.current = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      // A slow machine can take longer than one tick to detect — skip
      // rather than pile up overlapping detections.
      if (trackingInFlightRef.current) return;
      trackingInFlightRef.current = true;

      try {
        // Tiny landmarks normally; the accurate ones while a guided step runs.
        const useTinyLandmarks = !(livenessListenerRef.current && fullLandmarksReadyRef.current);
        const result = await faceapi
          .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 }))
          .withFaceLandmarks(useTinyLandmarks);

        if (!result) {
          eyewearHistoryRef.current = [];
          setFaceFrame(null);
          setEyewearDetected(false);
          livenessListenerRef.current?.(null);
          return;
        }

        eyewearHistoryRef.current = [...eyewearHistoryRef.current, detectEyewear(video, result.landmarks)].slice(
          -EYEWEAR_WINDOW,
        );
        setEyewearDetected(isEyewearConfirmed(eyewearHistoryRef.current));
        livenessListenerRef.current?.({
          video,
          landmarks: result.landmarks,
          box: result.detection.box,
          score: result.detection.score,
        });

        const box = result.detection.box;
        const scale = Math.max(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
        const renderedWidth = video.videoWidth * scale;
        const renderedHeight = video.videoHeight * scale;
        const cropX = (renderedWidth - video.clientWidth) / 2;
        const cropY = (renderedHeight - video.clientHeight) / 2;
        // Pad relative to the box's SCALED (on-screen) size, not its raw
        // video-pixel size — box.x/box.y below are already multiplied by
        // `scale` to land in display coordinates, so padding has to be in
        // that same unit or it over/undershoots whenever scale isn't 1
        // (e.g. a camera capturing larger than it's displayed).
        const scaledBoxWidth = box.width * scale;
        const scaledBoxHeight = box.height * scale;
        // The raw detector box hugs eyebrows-to-chin and misses the forehead
        // and hair entirely, so padding is asymmetric: a lot more added above
        // (to reach the hairline) than below (the chin is already close to
        // the box's bottom edge, just needs a touch of room).
        const padX = scaledBoxWidth * 0.08;
        const padTop = scaledBoxHeight * 0.35;
        const padBottom = scaledBoxHeight * 0.05;

        // The preview video is mirrored for display (selfie view, see the
        // scaleX(-1) on the <video> element) but detection runs against the
        // raw, unmirrored frame — so the box has to be flipped horizontally
        // to land on the same side the face actually appears on screen.
        // Without this the guide box moved opposite to real face motion.
        const rawX = Math.max(0, (box.x * scale) - cropX - padX);
        const y = Math.max(0, (box.y * scale) - cropY - padTop);
        const boxWidth = Math.min(video.clientWidth - rawX, scaledBoxWidth + padX * 2);
        const boxHeight = Math.min(video.clientHeight - y, scaledBoxHeight + padTop + padBottom);
        const x = Math.max(0, video.clientWidth - rawX - boxWidth);

        // Mirrors the size/confidence gates detectFace() itself enforces at
        // capture time, so the box only turns green when a capture right now
        // would actually succeed.
        const inOval = isFaceInOval(faceOvalRef.current, video, box);
        const ready = result.detection.score >= 0.75 && box.width >= 120 && box.height >= 120 && inOval;

        setFaceFrame({
          width: video.clientWidth,
          height: video.clientHeight,
          x,
          y,
          boxWidth,
          boxHeight,
          ready,
          inOval,
        });
      } catch {
        eyewearHistoryRef.current = [];
        setFaceFrame(null);
        setEyewearDetected(false);
        livenessListenerRef.current?.(null);
      } finally {
        trackingInFlightRef.current = false;
      }
    }, trackingRateRef.current);
  }

  function stopFaceTracking() {
    if (faceTrackingTimerRef.current) {
      window.clearInterval(faceTrackingTimerRef.current);
      faceTrackingTimerRef.current = null;
    }
  }

  function setFaceTrackingRate(ms: number) {
    if (trackingRateRef.current === ms) return;
    trackingRateRef.current = ms;
    if (faceTrackingTimerRef.current) {
      stopFaceTracking();
      startFaceTracking(true);
    }
  }

  // Resolves once the live tracker sees this step's movement; rejects on
  // timeout (retryable) or LivenessCancelled (Reset / camera stopped).
  function waitForStep(key: LivenessStepKey, timeoutMessage: string) {
    return new Promise<void>((resolve, reject) => {
      let heldSince: number | null = null;
      // Blink: two independent signals, either one completing a blink passes.
      // Both only count while the head is still and facing forward — any
      // head movement starts them over, so turning or shifting the head can
      // never pass for a blink.
      //
      // For the backend, each blink sends its most-closed frame and then a
      // frame with the eyes open again. The contrast signal reads the video
      // the moment it samples, so its frames are preferred; the landmark
      // signal's reading is a little older than the frame grabbed for it.
      const blinksNeeded = livenessSessionRef.current?.blinkCount ?? 1;
      let blinksDone = 0;
      let closedFrame: { closedness: number; image: string; fromContrast: boolean } | null = null;
      const noteClosed = (video: HTMLVideoElement, closedness: number, fromContrast: boolean) => {
        const better =
          !closedFrame ||
          (fromContrast && (!closedFrame.fromContrast || closedness < closedFrame.closedness)) ||
          (!fromContrast && !closedFrame.fromContrast && closedness < closedFrame.closedness);
        if (better) closedFrame = { closedness, image: imageFromVideo(video), fromContrast };
      };
      const newDetectors = () => ({
        landmark: createBlinkDetector(BLINK_CLOSED_RATIO, BLINK_OPEN_RATIO, (c) => {
          if (latestEyes) noteClosed(latestEyes.video, c, false);
        }),
        contrast: createBlinkDetector(BLINK_CONTRAST_CLOSED_RATIO, BLINK_CONTRAST_OPEN_RATIO, (c) => {
          if (latestEyes) noteClosed(latestEyes.video, c, true);
        }),
      });
      let detectors = newDetectors();
      const restartBlink = () => {
        detectors = newDetectors();
        closedFrame = null;
        latestEyes = null;
      };
      const blinkSeen = (video: HTMLVideoElement) => {
        if (!closedFrame) {
          restartBlink();
          return;
        }
        submitLivenessFrame("closed", closedFrame.image);
        submitLivenessFrame("open", imageFromVideo(video));
        blinksDone += 1;
        if (blinksDone >= blinksNeeded) {
          finish();
          return;
        }
        detectors = newDetectors();
        closedFrame = null;
        setLivenessHint("Good. Blink once more.");
      };
      // Latest eye positions from the tracker, for the fast contrast sampler.
      let latestEyes: { video: HTMLVideoElement; axes: FaceAxes; at: number } | null = null;
      let eyeSampler: number | null = null;

      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        if (eyeSampler !== null) window.clearInterval(eyeSampler);
        livenessListenerRef.current = null;
        livenessAbortRef.current = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = window.setTimeout(() => finish(new Error(timeoutMessage)), LIVENESS_STEP_TIMEOUT_MS);
      livenessAbortRef.current = () => finish(new LivenessCancelled());

      if (key === "blink") {
        // The head is held still (see restartBlink), so the eye positions
        // from the last detection are good enough to sample in between — as
        // long as they're fresh.
        eyeSampler = window.setInterval(() => {
          if (!latestEyes || performance.now() - latestEyes.at > BLINK_EYES_MAX_AGE_MS) return;
          const contrast = eyeContrast(latestEyes.video, latestEyes.axes);
          if (contrast !== null && detectors.contrast(contrast)) blinkSeen(latestEyes.video);
        }, BLINK_SAMPLE_MS);
      }

      livenessListenerRef.current = (face) => {
        const eyewear = isEyewearConfirmed(eyewearHistoryRef.current);
        const inOval = Boolean(face && isFaceInOval(faceOvalRef.current, face.video, face.box));
        const positionHint = getPositionHint(face, eyewear, inOval);

        if (!face) {
          heldSince = null;
          if (key === "blink") restartBlink();
          setLivenessHint(positionHint);
          return;
        }
        const yaw = headYaw(face.landmarks);

        if (key === "straight" || key === "center") {
          const straight = Math.abs(yaw) <= YAW_STRAIGHT;
          setLivenessHint(positionHint || (straight ? "" : "Face the camera directly."));
          // Same confidence the capture needs, held steady for a moment.
          if (positionHint || !straight || face.score < 0.75) {
            heldSince = null;
            return;
          }
          heldSince ??= performance.now();
          if (performance.now() - heldSince < (key === "center" ? LIVENESS_CAPTURE_HOLD_MS : LIVENESS_HOLD_MS)) return;
          finish();
          return;
        }

        if (key === "blink") {
          // Eye openness is only comparable while facing the camera.
          if (Math.abs(yaw) > YAW_BLINK_MAX) {
            setLivenessHint("Face the camera directly.");
            restartBlink();
            return;
          }
          const axes = faceAxes(face.landmarks);
          const previous = latestEyes?.axes;
          // Head moved since the last detection (position or distance).
          const moved =
            !axes ||
            (previous !== undefined &&
              (distance(axes.mid, previous.mid) / axes.d > BLINK_MAX_HEAD_SHIFT ||
                Math.abs(axes.d - previous.d) / previous.d > BLINK_MAX_HEAD_SHIFT));
          if (moved) {
            setLivenessHint("Keep your head still.");
            restartBlink();
            if (axes) latestEyes = { video: face.video, axes, at: performance.now() };
            return;
          }
          if (positionHint || blinksDone === 0) setLivenessHint(positionHint);
          // Outside the oval: nothing counts until the face is back inside.
          if (!inOval) {
            restartBlink();
            return;
          }
          latestEyes = { video: face.video, axes, at: performance.now() };
          if (detectors.landmark(eyeOpenness(face.landmarks))) blinkSeen(face.video);
          return;
        }

        // left / right
        const wanted = key === "left" ? yaw >= YAW_TURN : yaw <= -YAW_TURN;
        const opposite = key === "left" ? yaw <= -YAW_TURN : yaw >= YAW_TURN;
        // Turned the opposite way: the instruction card switches to a warning.
        // A turn only counts with the face inside the oval.
        if (!inOval) {
          setLivenessWrongWay(false);
          setLivenessHint(FACE_OUTSIDE_OVAL_HINT);
          return;
        }
        setLivenessWrongWay(opposite);
        setLivenessHint(
          !opposite && (positionHint === "No face detected. Face the camera." || positionHint === "Move closer to the camera.")
            ? positionHint
            : "",
        );
        if (wanted) {
          setLivenessWrongWay(false);
          finish();
        }
      };
    });
  }

  // The existing capture is stricter than the live tracker (bigger detector
  // input, its own score threshold), so in dim light one attempt can miss
  // even with the face confirmed straight. Keep re-confirming and retrying
  // until the step's time runs out instead of failing on the first miss.
  async function captureWhenStraight(key: LivenessStepKey, timeoutMessage: string) {
    const deadline = performance.now() + LIVENESS_STEP_TIMEOUT_MS;
    for (;;) {
      await waitForStep(key, timeoutMessage);
      if (!sequenceRef.current) throw new LivenessCancelled();
      // Pause the 10/s tracker so the (heavier) capture detection gets the
      // machine to itself — they otherwise slow each other down.
      stopFaceTracking();
      while (trackingInFlightRef.current) await delay(20);
      try {
        return await captureCurrentFrame();
      } catch (error) {
        if (!sequenceRef.current) throw new LivenessCancelled();
        // Tracking back on before anything else, so a retry (now or after
        // the step fails) has live frames again.
        if (streamRef.current) startFaceTracking(true);
        if (performance.now() >= deadline) throw error;
      }
    }
  }

  function imageFromVideo(video: HTMLVideoElement) {
    const canvas = document.createElement("canvas");
    const size = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = 480;
    canvas.height = 480;
    canvas.getContext("2d")?.drawImage(
      video,
      (video.videoWidth - size) / 2,
      (video.videoHeight - size) / 2,
      size,
      size,
      0,
      0,
      480,
      480,
    );
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  async function captureCurrentFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      throw new Error("Camera is still warming up. Please try again.");
    }
    const descriptor = await detectFace(video);
    const image = imageFromVideo(video);
    setDescriptors((current) => [...current.slice(0, CAMERA_SAMPLE_TARGET - 1), descriptor]);
    setPreview(image);
    return image;
  }

  // Queues one key frame for the backend. Frames go strictly one after
  // another, in the order the steps happened; once the backend rejects one
  // (or can't be reached) the rest are skipped and the attempt fails.
  function submitLivenessFrame(kind: "straight" | "closed" | "open" | "left" | "right" | "final", image: string) {
    const session = livenessSessionRef.current;
    if (!session) return;
    frameChainRef.current = frameChainRef.current.then(async () => {
      if (session.failure || livenessSessionRef.current !== session) return;
      try {
        const result = await apiRequest<LivenessFrameResult>(`/face-profiles/liveness-sessions/${session.id}/frames`, {
          method: "POST",
          body: JSON.stringify({ kind, image }),
        });
        if (result.status === "failed") session.failure = result.reason ?? "Liveness verification failed.";
        if (result.status === "verified") session.verified = true;
      } catch {
        session.failure = "Couldn't reach the server to verify liveness. Check the connection and try again.";
      }
    });
  }

  // Waits for every frame queued so far to be judged by the backend; true
  // if that took longer than LIVENESS_VERIFY_TIMEOUT_MS.
  async function livenessTimedOut() {
    let timer = 0;
    const timedOut = await Promise.race([
      frameChainRef.current.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = window.setTimeout(() => resolve(true), LIVENESS_VERIFY_TIMEOUT_MS);
      }),
    ]);
    window.clearTimeout(timer);
    return timedOut;
  }

  function throwIfLivenessFailed() {
    const failure = livenessSessionRef.current?.failure;
    if (failure) throw new Error(failure);
  }

  async function startGuidedCapture() {
    if (!cameraActive || busy) return;
    if (!selectedEmployee) {
      setMessage("Select an employee first.");
      return;
    }
    if (eyewearDetected) {
      setMessage("Eyeglasses or sunglasses detected. Please remove them before capturing.");
      return;
    }
    sequenceRef.current = true;
    setBusy(true);
    setDescriptors([]);
    setPreview("");
    setVerifiedSessionId(null);
    // The instruction card on the camera says what to do.
    setMessage("");

    try {
      // Every attempt is a new backend session with a new random step order
      // — a failed or cancelled one is never resumed.
      const session = await apiRequest<{ sessionId: string; challenges: LivenessChallenge[]; blinkCount: number }>(
        "/face-profiles/liveness-sessions",
        { method: "POST", body: JSON.stringify({ employeeId: selectedEmployee.id }) },
      ).catch(() => {
        throw new Error("Couldn't start the liveness check. Check the server connection and try again.");
      });
      if (!sequenceRef.current) return;
      const steps = buildLivenessSteps(session.challenges, session.blinkCount);
      livenessSessionRef.current = { id: session.sessionId, blinkCount: session.blinkCount, failure: null, verified: false };
      frameChainRef.current = Promise.resolve();
      setLivenessSteps(steps);
      setFaceTrackingRate(LIVENESS_TRACKING_MS);

      for (let index = 0; index < steps.length; index += 1) {
        if (!sequenceRef.current) return;
        const step = steps[index];
        setLiveness({ step: index, status: "active" });
        setLivenessHint("");
        setLivenessWrongWay(false);
        // The last step ends with the existing capture, right after the face
        // is confirmed straight and centered; that photo is also the final
        // frame the backend verifies (and later stores).
        if (index === steps.length - 1) {
          submitLivenessFrame("final", await captureWhenStraight(step.key, step.timeout));
        } else {
          await waitForStep(step.key, step.timeout);
          // Straight and turns: the frame right as the step is detected.
          // (Blinks send their own frames — see waitForStep.)
          if (step.key !== "blink" && videoRef.current) {
            submitLivenessFrame(step.key as "straight" | "left" | "right", imageFromVideo(videoRef.current));
          }
          // Step 1 isn't ticked until the backend's anti-spoofing check has
          // judged that frame a live face, so a photo or a phone screen
          // stops right here.
          if (step.key === "straight") {
            setLivenessHint(LIVE_FACE_CHECK_HINT);
            if (await livenessTimedOut()) throw new Error("Liveness verification timed out. Please try again.");
            if (!sequenceRef.current) return;
          }
        }
        throwIfLivenessFailed();
        setLiveness({ step: index, status: "passed" });
        await delay(index === steps.length - 1 ? LIVENESS_CAPTURED_PAUSE_MS : LIVENESS_PASS_PAUSE_MS);
      }
      if (!sequenceRef.current) return;

      // The verdict: wait for the backend to finish measuring every frame.
      setLivenessVerifying(true);
      const timedOut = await livenessTimedOut();
      if (!sequenceRef.current) return;
      setLivenessVerifying(false);
      if (timedOut) throw new Error("Liveness verification timed out. Please try again.");
      throwIfLivenessFailed();
      if (!livenessSessionRef.current?.verified) throw new Error("Liveness verification failed. Please try again.");

      setVerifiedSessionId(session.sessionId);
      sequenceRef.current = false;
      stopCamera();
      setMessage("");
      setShowCapturePreview(true);
    } catch (error) {
      sequenceRef.current = false;
      if (error instanceof LivenessCancelled) return;
      const reason = error instanceof Error ? error.message : "Face capture failed.";
      // Never leave an unverified capture behind to be registered.
      livenessSessionRef.current = null;
      setLivenessVerifying(false);
      setDescriptors([]);
      setPreview("");
      setLiveness((current) => ({ step: current?.step ?? 0, status: "failed", reason }));
      setLivenessHint("");
      setMessage("");
    } finally {
      setBusy(false);
      if (streamRef.current) {
        setFaceTrackingRate(FACE_TRACKING_MS);
        // The photo step pauses tracking; a retry needs it running again.
        if (!faceTrackingTimerRef.current) startFaceTracking(true);
      }
    }
  }

  function closeCapturePreview() {
    setShowCapturePreview(false);
    setMessage("Guided face capture complete. Review the details and register the employee.");
  }

  function resetCapture() {
    sequenceRef.current = false;
    clearLiveness();
    setVerifiedSessionId(null);
    setShowCapturePreview(false);
    setDescriptors([]);
    setPreview("");
    setFaceFrame(null);
    setBusy(false);
    setMessage(cameraActive ? "Capture reset. Begin the guided capture again." : "Start the camera for a guided face capture.");
  }

  async function saveEnrollment() {
    if (!selectedEmployee) {
      setMessage("Select an employee first.");
      return;
    }
    if (selectedEmployee.requiresFaceConsent && !selectedEmployee.faceConsentAcceptedAt) {
      setMessage("This employee must accept the face-data consent on the mobile app before registration.");
      return;
    }
    if (!preview || descriptors.length < CAMERA_SAMPLE_TARGET || !verifiedSessionId) {
      setMessage("Complete the guided capture and liveness check before registering.");
      return;
    }
    setBusy(true);
    setMessage("Registering face photo...");
    try {
      const employeeToRegister = selectedEmployee;
      const enrollmentIdBeingEdited = editingEnrollmentId;
      // The backend upserts by employee: an active profile gets replaced in
      // place, so re-registration never stacks duplicate rows.
      const wasReRegistration = Boolean(
        enrollmentIdBeingEdited ||
          enrollments.some((item) => item.employeeId === employeeToRegister.id && !item.isArchived),
      );
      // Only the verified session is sent: the backend saves the photo and
      // face signature it verified itself, not anything from this page.
      const saved = await apiRequest<FaceProfile>("/face-profiles", {
        method: "POST",
        body: JSON.stringify({
          employeeId: employeeToRegister.id,
          livenessSessionId: verifiedSessionId,
        }),
      });
      setEnrollments((current) =>
        current.some((item) => item.id === saved.id)
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...current.filter((item) => item.employeeId !== saved.employeeId)],
      );
      setLastRegisteredEmployee(employeeToRegister);
      setLastActionWasEdit(wasReRegistration);
      setShowSuccessModal(true);
      setShowCapturePreview(false);
      // Registering the handed-over employee ends the locked handoff; an edit
      // done while the handoff is still pending re-selects them instead.
      const handoffPending = Boolean(initialEmployee && !handoffCompleted);
      if (!enrollmentIdBeingEdited && handoffPending) setHandoffCompleted(true);
      setSelectedEmployee(enrollmentIdBeingEdited && handoffPending ? initialEmployee! : null);
      setEditingEnrollmentId(null);
      setDescriptors([]);
      setPreview("");
      setVerifiedSessionId(null);
      setFaceFrame(null);
      stopCamera();
    } catch (error) {
      // The backend refused the capture itself (expired or not verified):
      // it can't be registered, so the guided capture must be redone.
      if (error instanceof Error && /liveness/i.test(error.message)) {
        setVerifiedSessionId(null);
        setMessage(error.message);
      } else {
        setMessage("Unable to register the face profile. Check the backend connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  function archiveEnrollment(id: string) {
    setArchiving(true);
    apiRequest(`/face-profiles/${id}/archive`, { method: "PATCH", body: JSON.stringify({}) })
      .then(() => {
        setEnrollments((current) =>
          current.map((item) => (item.id === id ? { ...item, isArchived: true, referenceImageData: null } : item)),
        );
        setArchiveTarget(null);
      })
      .finally(() => setArchiving(false));
  }

  function dismissSuccessModal() {
    setShowSuccessModal(false);
    setLastRegisteredEmployee(null);
    setLastActionWasEdit(false);
    setMessage("");
  }

  function openViewModal(profile: FaceProfile) {
    setViewProfile(profile);
  }

  function closeViewModal() {
    setViewProfile(null);
  }

  function editProfilePhoto(profile: FaceProfile) {
    setViewProfile(null);
    setEditingEnrollmentId(profile.id);
    setSelectedEmployee(profile.employee);
    setMessage(`Editing face photo for ${employeeLabel(profile.employee)}. Starting camera...`);
    captureCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    startCamera();
  }

  const { departmentNames: departmentOptions } = useActiveDepartments();
  const { forEmployees: attendanceModeOptions } = useAttendanceModeOptions();

  const enrollmentsBeforeModeFilter = enrollments
    .filter((item) => listDepartmentFilter === "ALL" || item.employee.department?.name === listDepartmentFilter)
    .filter((item) => {
      const query = listSearch.trim().toLowerCase();
      if (!query) return true;
      return (
        employeeLabel(item.employee).toLowerCase().includes(query) ||
        item.employee.employeeNo.toLowerCase().includes(query)
      );
    });

  // Archived faces live only under the Archived tab, never the active ones.
  const activeEnrollments = enrollmentsBeforeModeFilter.filter((item) => !item.isArchived);
  const archivedEnrollments = enrollmentsBeforeModeFilter.filter((item) => item.isArchived);
  const enrollmentModeCounts = {
    all: activeEnrollments.length,
    field: activeEnrollments.filter((item) => item.employee.attendanceMode === "FIELD").length,
    fixed: activeEnrollments.filter((item) => item.employee.attendanceMode !== "FIELD").length,
    archived: archivedEnrollments.length,
  };

  const visibleEnrollments =
    listModeFilter === "ARCHIVED"
      ? archivedEnrollments
      : listModeFilter === "ALL"
        ? activeEnrollments
        : activeEnrollments.filter((item) =>
            listModeFilter === "FIELD" ? item.employee.attendanceMode === "FIELD" : item.employee.attendanceMode !== "FIELD",
          );

  useEffect(() => setEnrollmentsPage(1), [listDepartmentFilter, listModeFilter, listSearch]);
  const enrollmentsPageCount = Math.max(1, Math.ceil(visibleEnrollments.length / ENROLLMENTS_PAGE_SIZE));
  const enrollmentsPageSafe = Math.min(enrollmentsPage, enrollmentsPageCount);
  const pagedEnrollments = visibleEnrollments.slice(
    (enrollmentsPageSafe - 1) * ENROLLMENTS_PAGE_SIZE,
    enrollmentsPageSafe * ENROLLMENTS_PAGE_SIZE,
  );

  // While the handed-over new employee hasn't been registered yet, the picker
  // is hidden entirely — the panel shows only their details, and Cancel just
  // resets the capture without unlocking the search.
  const isPreselectedNewEmployee = Boolean(initialEmployee && !editingEnrollmentId && !handoffCompleted);

  // Display-only timestamp for the capture review modal.
  const capturedAt = useMemo(() => new Date(), [preview]);

  const selectedProfile = selectedEmployee
    ? enrollments.find((item) => item.employeeId === selectedEmployee.id) ?? null
    : null;
  const selectedEnrollment = selectedProfile && !selectedProfile.isArchived ? selectedProfile : null;
  // An archived face still belongs to an existing employee, never a new one.
  const selectedFaceArchived = Boolean(selectedProfile?.isArchived);

  // Blocks Face Registration until the employee accepts the face-data
  // consent on mobile — see the "Employee Consent Required" modal below.
  // Pre-existing employees (requiresFaceConsent === false) are exempt.
  const consentPending = Boolean(
    selectedEmployee?.requiresFaceConsent && !selectedEmployee.faceConsentAcceptedAt,
  );

  // Lets the admin re-check without restarting the employee-creation flow:
  // re-fetches the employee list (no single-employee GET endpoint exists)
  // and swaps in the fresh record if the employee has since accepted.
  function loadAllEmployees() {
    apiRequest<Employee[]>("/employees").then(setAllEmployees).catch(() => undefined);
  }

  useEffect(loadAllEmployees, []);
  // Keeps consent statuses current while the list is showing, so an employee
  // who just accepted on mobile becomes selectable without a reload.
  useLiveRefresh(loadAllEmployees, !selectedEmployee);

  // Active employees with no registered face yet, ready ones first. Those
  // still waiting for consent are listed but can't be selected.
  const hasPendingConsent = (employee: Employee) =>
    Boolean(employee.requiresFaceConsent && !employee.faceConsentAcceptedAt);
  const awaitingEmployees = allEmployees
    .filter(
      (employee) =>
        employee.employmentStatus !== "SEPARATED" &&
        !enrollments.some((item) => item.employeeId === employee.id && !item.isArchived) &&
        (awaitingDepartmentFilter === "ALL" || employee.department?.name === awaitingDepartmentFilter),
    )
    .sort(
      (a, b) =>
        Number(hasPendingConsent(a)) - Number(hasPendingConsent(b)) ||
        employeeLabel(a).localeCompare(employeeLabel(b)),
    );

  // Picks the employee only — the camera is started by the admin as usual.
  function selectAwaitingEmployee(employee: Employee) {
    if (hasPendingConsent(employee)) return;
    setEditingEnrollmentId(null);
    resetCapture();
    setSelectedEmployee(employee);
    // Until the models/records have loaded, keep the loading (or load error)
    // message rather than inviting a camera start that isn't available yet.
    if (modelsReady) setMessage(`Start the camera to register ${employeeLabel(employee)}'s face.`);
  }

  async function refreshConsentStatus() {
    if (!selectedEmployee) return;
    setConsentRefreshing(true);
    try {
      const employees = await apiRequest<Employee[]>("/employees");
      const updated = employees.find((item) => item.id === selectedEmployee.id);
      if (updated) setSelectedEmployee(updated);
    } finally {
      setConsentRefreshing(false);
    }
  }

  // Auto-closes the consent modal the moment the employee accepts on mobile
  // — polls silently (no "Checking..." button state) only while the modal
  // is actually showing, so the admin never has to click "Check Again" or
  // reload the page. Re-fetching swaps in the fresh employee record, which
  // recomputes consentPending to false and the modal unmounts on its own.
  useEffect(() => {
    if (!consentPending || !selectedEmployee) return;
    const employeeId = selectedEmployee.id;
    const interval = window.setInterval(async () => {
      try {
        const employees = await apiRequest<Employee[]>("/employees");
        const updated = employees.find((item) => item.id === employeeId);
        if (updated) setSelectedEmployee(updated);
      } catch {
        // Silent — the next tick retries.
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [consentPending, selectedEmployee?.id]);

  function enrollmentStatusTone(status: FaceProfile["enrollmentStatus"]) {
    if (status === "ACTIVE") return "success" as const;
    if (status === "REJECTED") return "danger" as const;
    return "warning" as const;
  }

  // Display state for the step bar and instruction card, derived
  // from the real detection progress in `liveness`.
  const livenessStepsDone = liveness ? (liveness.status === "passed" ? liveness.step + 1 : liveness.step) : 0;
  const currentLivenessStep = livenessSteps[liveness?.step ?? 0] ?? livenessSteps[0];
  const livenessGroups = livenessGroupLabels(livenessSteps);
  const livenessView = {
    currentGroup: currentLivenessStep.group,
    // Share of all steps really detected so far (0-100), for the oval ring.
    progress: (livenessStepsDone / livenessSteps.length) * 100,
    cue: liveness?.status === "active" ? currentLivenessStep.key : null,
    groupDone: (group: number) =>
      livenessSteps.every((step, index) => step.group !== group || index < livenessStepsDone),
    wrongWay: liveness?.status === "active" && livenessWrongWay,
    title: livenessVerifying
      ? "Verifying liveness..."
      : !liveness
      ? currentLivenessStep.instruction
      : liveness.status === "active" && livenessWrongWay
        ? `Incorrect direction. Please turn your head to the ${currentLivenessStep.key}.`
      : liveness.status === "passed"
        ? currentLivenessStep.passed
        : liveness.status === "failed"
          ? `Liveness verification failed. ${liveness.reason ?? currentLivenessStep.timeout}`
          : currentLivenessStep.instruction,
    sub: livenessVerifying
      ? "Checking the captured frames. Please wait."
      : !liveness
      ? "Click Start guided capture to begin."
      : liveness.status === "failed"
        ? "Click Start guided capture to try again."
        : liveness.status === "passed"
          ? ""
          : livenessWrongWay
            ? currentLivenessStep.instruction
            : livenessHint || currentLivenessStep.sub,
  };

  // Status tile: where the capture stands, from waiting for a face through
  // to a liveness result.
  const captureStatus: { label: string; tone: "good" | "bad" | null } = verifiedSessionId
    ? { label: "Liveness verified", tone: "good" }
    : !cameraActive
      ? { label: selectedEmployee ? "Ready for capture" : "Choose an employee first", tone: null }
      : livenessVerifying || livenessHint === LIVE_FACE_CHECK_HINT
        ? { label: "Verifying liveness...", tone: "good" }
        : liveness?.status === "failed"
          ? { label: "Liveness verification failed", tone: "bad" }
          : eyewearDetected
            ? { label: "Remove eyeglasses", tone: "bad" }
            : liveness?.status === "active" && (livenessWrongWay || livenessHint)
              ? { label: "Action required", tone: "bad" }
              : liveness
                ? { label: "Liveness check in progress", tone: "good" }
                : !faceFrame
                  ? { label: "Waiting for face", tone: "bad" }
                  : faceFrame.inOval
                    ? { label: "Face detected", tone: "good" }
                    : { label: "Face outside the oval", tone: "bad" };

  return (
    <div className="face-page">
      <div className="face-workspace">
        <section className="face-card capture-card" ref={captureCardRef}>
          <div className="capture-summary">
            <div className="capture-summary-tile">
              <span className="capture-summary-icon"><Camera size={17} /></span>
              <div>
                <p>{editingEnrollmentId ? "Editing photo for" : "Selected employee"}</p>
                <strong>{selectedEmployee ? employeeLabel(selectedEmployee) : "None selected"}</strong>
              </div>
            </div>
            <div className="capture-summary-tile">
              <span
                className={`capture-summary-icon${
                  captureStatus.tone === "good" ? " is-good" : captureStatus.tone === "bad" ? " is-bad" : ""
                }`}
              >
                {captureStatus.tone === "bad" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
              </span>
              <div>
                <p>Status</p>
                <strong
                className={
                  captureStatus.tone === "good"
                    ? "status-face-detected"
                    : captureStatus.tone === "bad"
                      ? "status-face-missing"
                      : undefined
                }
              >
                {captureStatus.label}
              </strong>
              </div>
            </div>
            <div className="capture-summary-tile">
              <span className="capture-summary-icon"><Users size={17} /></span>
              <div>
                <p>Registered Employees</p>
                <strong className="capture-summary-count">{enrollments.filter((item) => !item.isArchived).length}</strong>
              </div>
            </div>
          </div>

          <div className="capture-stage">
            {cameraActive ? (
              <video ref={videoRef} autoPlay muted playsInline disablePictureInPicture />
            ) : preview ? (
              <img src={preview} alt="Face enrollment preview" />
            ) : (
              <div className="capture-placeholder"><ScanFace size={72} /><span>No face captured</span></div>
            )}
            {/* GCash-style oval: the camera outside it is dimmed, its outline
                turns green when the face is ready, the ring fills as steps are
                really detected, and each step shows its own moving cue. */}
            {cameraActive && (
              <div
                className={`face-oval-overlay${
                  liveness?.status === "passed"
                    ? " is-passed"
                    : faceFrame?.ready && !eyewearDetected
                      ? " is-ready"
                      : ""
                }`}
                aria-hidden="true"
              >
                <div className="face-oval" ref={faceOvalRef}>
                  {/* Same 4:5 shape as the oval, so the ring is drawn unstretched.
                      The path starts at the top and runs clockwise (right side,
                      bottom, left side), so the progress fills from 12 o'clock. */}
                  <svg className="face-oval-ring" viewBox="0 0 80 100">
                    <path className="face-oval-track" d={FACE_OVAL_PATH} />
                    <path
                      className="face-oval-progress"
                      d={FACE_OVAL_PATH}
                      pathLength={100}
                      strokeDasharray={`${livenessView.progress} 100`}
                      opacity={livenessView.progress > 0 ? 1 : 0}
                    />
                  </svg>
                  {livenessView.cue === "blink" && (
                    <span className="face-cue face-cue-blink">
                      <Eye size={20} />
                    </span>
                  )}
                  {/* The preview is mirrored, so the employee's left is the screen's left. */}
                  {livenessView.cue === "left" && (
                    <span className={`face-cue face-cue-left${livenessView.wrongWay ? " is-urgent" : ""}`}>
                      <ChevronLeft size={30} strokeWidth={3} />
                    </span>
                  )}
                  {livenessView.cue === "right" && (
                    <span className={`face-cue face-cue-right${livenessView.wrongWay ? " is-urgent" : ""}`}>
                      <ChevronRight size={30} strokeWidth={3} />
                    </span>
                  )}
                  {liveness?.status === "passed" && (
                    <span
                      key={liveness.step}
                      className={`face-oval-check${liveness.step === livenessSteps.length - 1 ? " is-final" : ""}`}
                    >
                      <Check size={30} strokeWidth={3} />
                    </span>
                  )}
                </div>
              </div>
            )}
            {/* Camera flash the moment the photo is actually taken. */}
            {cameraActive && liveness?.status === "passed" && liveness.step === livenessSteps.length - 1 && (
              <div className="capture-flash" aria-hidden="true" />
            )}
            {cameraActive && (
              <div className="liveness-stepbar" aria-hidden="true">
                <span className="liveness-stepbar-label">
                  Step {livenessView.currentGroup + 1} of {livenessGroups.length}
                </span>
                {livenessGroups.map((label, group) => (
                  <span key={label} className="liveness-stepbar-item">
                    {group > 0 && (
                      <span className={`liveness-stepbar-line${livenessView.groupDone(group - 1) ? " is-done" : ""}`} />
                    )}
                    <span
                      className={`liveness-dot${
                        livenessView.groupDone(group)
                          ? " is-done"
                          : group === livenessView.currentGroup
                            ? ` is-${liveness?.status ?? "active"}`
                            : ""
                      }`}
                    >
                      {livenessView.groupDone(group) ? <Check size={11} strokeWidth={3} /> : group + 1}
                    </span>
                  </span>
                ))}
              </div>
            )}
            {/* Instruction card — the eyewear warning takes this spot until a
                guided capture starts. */}
            {cameraActive && (liveness || !eyewearDetected) && (
              <div
                className={`liveness-card is-${liveness?.status ?? "idle"}${livenessView.wrongWay ? " is-wrong-way" : ""}`}
                role="status"
                aria-live="polite"
              >
                <span className="liveness-card-icon">
                  {liveness?.status === "passed" ? (
                    <CheckCircle2 size={20} />
                  ) : liveness?.status === "failed" || livenessView.wrongWay ? (
                    <AlertTriangle size={20} />
                  ) : (
                    <ScanFace size={20} />
                  )}
                </span>
                <div>
                  <strong>{livenessView.title}</strong>
                  {livenessView.sub && <span>{livenessView.sub}</span>}
                </div>
              </div>
            )}
            {cameraActive && eyewearDetected && !liveness && (
              <div className="eyewear-warning" role="alert">
                <AlertTriangle size={15} />
                <span>Eyeglasses or sunglasses detected — please remove them to continue.</span>
              </div>
            )}

            {showSuccessModal && lastRegisteredEmployee && (
              <div className="success-modal-overlay">
                <div className="success-modal">
                  <button className="view-modal-close" onClick={dismissSuccessModal} aria-label="Close">
                    <X size={18} />
                  </button>
                  <div className="success-modal-icon">
                    <CheckCircle2 size={48} />
                  </div>
                  <h3>{lastActionWasEdit ? "Face Photo Updated" : "Face Registered Successfully"}</h3>
                  <p className="success-modal-name">{employeeLabel(lastRegisteredEmployee)}</p>
                  <p className="success-modal-sub">{lastRegisteredEmployee.department?.name ?? "No department"}</p>
                  <p className="success-modal-desc">
                    {lastActionWasEdit
                      ? "The reference photo for face recognition has been updated."
                      : "This employee can now use face recognition for attendance verification."}
                  </p>
                  <button className="primary-button success-modal-btn" onClick={dismissSuccessModal}>Done</button>
                </div>
              </div>
            )}
          </div>

          {message && <p className="capture-message" role="status">{message}</p>}
          <div className="capture-actions">
            <button
              className="primary-button"
              onClick={cameraActive ? startGuidedCapture : startCamera}
              disabled={!modelsReady || busy || !selectedEmployee || (cameraActive && eyewearDetected)}
            >
              <Camera size={17} /> {busy ? "Guided capture in progress..." : cameraActive ? "Start guided capture" : "Start camera"}
            </button>
            {/* Stays usable while the movement steps run, to stop them. */}
            <button
              className="outline-button"
              onClick={resetCapture}
              disabled={(busy && !liveness) || (!cameraActive && descriptors.length === 0)}
            >
              <RotateCcw size={17} /> Reset
            </button>
          </div>
        </section>

        <section className="face-card enrollment-form">
          <div className="form-title-row">
            <div>
              <p className="form-kicker">{editingEnrollmentId ? "Editing" : "Face Registration"}</p>
              <h3>{editingEnrollmentId ? "Update Face Photo" : selectedEmployee ? (selectedFaceArchived ? "Existing Employee" : "New Employee") : "No Employee Selected"}</h3>
            </div>
            {/* Narrows the "Awaiting face registration" list below. */}
            {!selectedEmployee && (
              <DropdownFilter
                value={awaitingDepartmentFilter}
                onChange={setAwaitingDepartmentFilter}
                options={departmentOptions.map((name) => ({ value: name, label: name }))}
                allLabel="All Departments"
                menuLabel="Filter by department"
                ariaLabel="Filter awaiting employees by department"
                menuAlign="right"
              />
            )}
          </div>

          {editingEnrollmentId && (
            <p className="capture-message">Capture a new photo below for this employee, then save to replace their existing photo.</p>
          )}

          {selectedEmployee ? (
            <div className="selected-employee-card new-employee-details reregister-details">
              <div className="new-employee-details-name">
                {/* Their current registered photo, when there is one. */}
                {selectedEnrollment?.referenceImageData ? (
                  <button
                    type="button"
                    className="details-photo is-clickable"
                    onClick={() => setEnlargedPhoto(selectedEnrollment.referenceImageData)}
                    aria-label="View registered photo full size"
                  >
                    <img src={selectedEnrollment.referenceImageData} alt="" />
                  </button>
                ) : (
                  <span className="details-photo">
                    <User size={26} />
                  </span>
                )}
                <div>
                  <p>{editingEnrollmentId ? "Editing photo for" : selectedFaceArchived ? "Selected employee" : "New employee"}</p>
                  <strong>{employeeLabel(selectedEmployee)}</strong>
                </div>
              </div>
              {[
                { icon: Mail, label: "Email", value: selectedEmployee.user?.email ?? "—" },
                { icon: Building2, label: "Department", value: selectedEmployee.department?.name ?? "—" },
                {
                  icon: Network,
                  label: "Supervisor",
                  value: selectedEmployee.supervisor
                    ? `${selectedEmployee.supervisor.firstName} ${selectedEmployee.supervisor.lastName}`
                    : "None",
                },
                {
                  icon: Calendar,
                  label: "Hire Date",
                  value: selectedEmployee.hireDate ? new Date(selectedEmployee.hireDate).toLocaleDateString() : "—",
                },
                {
                  icon: Briefcase,
                  label: "Employment Status",
                  value: selectedEmployee.employmentStatus ? EMPLOYMENT_STATUS_LABELS[selectedEmployee.employmentStatus] : "—",
                },
                {
                  icon: MapPin,
                  label: "Attendance Mode",
                  value: formatAttendanceMode(selectedEmployee.attendanceMode, attendanceModeOptions),
                },
                {
                  icon: Fingerprint,
                  label: "Face Registration",
                  value: selectedEnrollment
                    ? selectedEnrollment.enrolledAt
                      ? `Registered · ${new Date(selectedEnrollment.enrolledAt).toLocaleDateString()}`
                      : "Registered"
                    : selectedFaceArchived
                      ? "Archived · not registered"
                      : "Not yet registered",
                },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="details-field">
                  <Icon size={16} className="details-field-icon" />
                  <div>
                    <p>{label}</p>
                    <strong>{value}</strong>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="awaiting-list">
              <div className="awaiting-list-head">
                <p>Awaiting face registration</p>
                <span>{awaitingEmployees.length}</span>
              </div>
              {awaitingEmployees.length === 0 ? (
                <p className="capture-message">
                  {awaitingDepartmentFilter === "ALL"
                    ? "Every active employee has a registered face."
                    : "No employees in this department are awaiting face registration."}
                </p>
              ) : (
                <ul>
                  {awaitingEmployees.map((employee) => {
                    const pending = hasPendingConsent(employee);
                    return (
                      <li key={employee.id} className={pending ? "is-pending" : undefined}>
                        <div>
                          <strong>{employeeLabel(employee)}</strong>
                          <span>{employee.department?.name ?? "No department"}</span>
                        </div>
                        {pending ? (
                          <span className="awaiting-tag" title="The employee must accept the face-data consent on the mobile app first.">
                            Waiting for consent
                          </span>
                        ) : (
                          <button type="button" className="outline-button awaiting-select" onClick={() => selectAwaitingEmployee(employee)}>
                            Select
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="awaiting-note">
                Employees added one by one or by batch import appear here. Those waiting for consent become selectable
                once they accept it on the mobile app. To re-register a face, use "Re-register" in the list below.
              </p>
            </div>
          )}

          <div className="form-actions">
            {/* In the handoff view the face is saved from the capture
                preview's "Looks Good" button, so no register button here. */}
            {!isPreselectedNewEmployee && (
              <button
                className="primary-button save-face-button"
                onClick={saveEnrollment}
                disabled={busy || descriptors.length < CAMERA_SAMPLE_TARGET || !selectedEmployee || !verifiedSessionId}
              >
                {editingEnrollmentId ? "Save New Photo" : selectedEnrollment ? "Re-register Employee Face" : "Register Employee Face"}
              </button>
            )}
            <button
              className="outline-button cancel-button"
              onClick={() => {
                setEditingEnrollmentId(null);
                // A pending handoff stays locked to the new employee; Cancel
                // only resets the capture instead of reopening the picker.
                setSelectedEmployee(initialEmployee && !handoffCompleted ? initialEmployee : null);
                resetCapture();
                stopCamera();
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </section>
      </div>

      <section className="face-card enrollment-list">
        <div className="list-heading">
          <div className="list-heading-left">
            <h3>Registered Employees</h3>
            <div className="registered-mode-tabs" role="tablist" aria-label="Filter registered employees by attendance mode or archived status">
              <button
                type="button"
                role="tab"
                aria-selected={listModeFilter === "ALL"}
                className={`registered-mode-tab${listModeFilter === "ALL" ? " is-selected" : ""}`}
                onClick={() => setListModeFilter("ALL")}
              >
                All
                <span className="registered-mode-tab-count">{enrollmentModeCounts.all}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={listModeFilter === "FIELD"}
                className={`registered-mode-tab${listModeFilter === "FIELD" ? " is-selected" : ""}`}
                onClick={() => setListModeFilter("FIELD")}
              >
                {formatAttendanceMode("FIELD", attendanceModeOptions)}
                <span className="registered-mode-tab-count">{enrollmentModeCounts.field}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={listModeFilter === "FIXED"}
                className={`registered-mode-tab${listModeFilter === "FIXED" ? " is-selected" : ""}`}
                onClick={() => setListModeFilter("FIXED")}
              >
                {formatAttendanceMode("FIXED", attendanceModeOptions)}
                <span className="registered-mode-tab-count">{enrollmentModeCounts.fixed}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={listModeFilter === "ARCHIVED"}
                className={`registered-mode-tab${listModeFilter === "ARCHIVED" ? " is-selected" : ""}`}
                onClick={() => setListModeFilter("ARCHIVED")}
              >
                Archived
                <span className="registered-mode-tab-count">{enrollmentModeCounts.archived}</span>
              </button>
            </div>
          </div>
          <div className="list-heading-right">
            <div className="registered-search">
              <Search size={14} className="registered-search-icon" />
              <input
                type="text"
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder="Search by name"
                aria-label="Search registered employees by name"
              />
              <button
                type="button"
                className="registered-search-clear"
                onClick={() => setListSearch("")}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            </div>
            <DropdownFilter
              value={listDepartmentFilter}
              onChange={setListDepartmentFilter}
              options={departmentOptions.map((name) => ({ value: name, label: name }))}
              allLabel="All Departments"
              menuLabel="Filter by department"
              ariaLabel="Department"
            />
            <span>{visibleEnrollments.length} total</span>
          </div>
        </div>

        {enrollments.length === 0 ? (
          <p className="empty-enrollments">No employees have been registered yet.</p>
        ) : (
          <>
            {visibleEnrollments.length === 0 ? (
              <p className="empty-enrollments">
                {listModeFilter === "ARCHIVED"
                  ? "No archived face registrations match this search or filter."
                  : "No registered employees match this search or filter."}
              </p>
            ) : (
              <div className="table-card">
                <div className="enrollment-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>NAME</th>
                      <th>DEPARTMENT</th>
                      <th>STATUS</th>
                      <th>DATE REGISTERED</th>
                      <th>ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedEnrollments.map((item) => (
                      <tr key={item.id}>
                        <td data-label="Name">{employeeLabel(item.employee)}</td>
                        <td data-label="Department">{item.employee.department?.name ?? "Unknown"}</td>
                        <td data-label="Status">
                          {item.isArchived ? (
                            <Badge tone="neutral">ARCHIVED</Badge>
                          ) : (
                            <Badge tone={enrollmentStatusTone(item.enrollmentStatus)}>{item.enrollmentStatus}</Badge>
                          )}
                        </td>
                        <td data-label="Date Registered">
                          {item.enrolledAt ? new Date(item.enrolledAt).toLocaleDateString() : "Pending"}
                        </td>
                        <td data-label="Action">
                          <button className="face-row-view" onClick={() => openViewModal(item)}>
                            <Eye size={14} /> View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <div className="enrollment-pagination">
                  <button
                    type="button"
                    className="outline-button"
                    disabled={enrollmentsPageSafe <= 1}
                    onClick={() => setEnrollmentsPage(enrollmentsPageSafe - 1)}
                  >
                    Previous
                  </button>
                  <span>Page {enrollmentsPageSafe} of {enrollmentsPageCount}</span>
                  <button
                    type="button"
                    className="outline-button"
                    disabled={enrollmentsPageSafe >= enrollmentsPageCount}
                    onClick={() => setEnrollmentsPage(enrollmentsPageSafe + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {showCapturePreview && preview && (
        // The handoff view has no separate register button, so the preview
        // must be resolved with "Confirm & Register" or "Retake" — not dismissed.
        <div className="view-modal-overlay" onClick={isPreselectedNewEmployee ? undefined : closeCapturePreview}>
          <div className="view-modal capture-review-modal" onClick={(event) => event.stopPropagation()}>
            {!isPreselectedNewEmployee && (
              <button className="view-modal-close capture-review-close" onClick={closeCapturePreview} aria-label="Close">
                <X size={15} />
              </button>
            )}
            {/* Green ring and check, matching the camera oval the scan just completed. */}
            <div className="capture-review-photo-wrap">
              <button
                type="button"
                className="view-modal-photo capture-review-photo is-clickable"
                onClick={() => setEnlargedPhoto(preview)}
                aria-label="View captured photo full size"
              >
                <img src={preview} alt="Captured face preview" />
              </button>
              <span className="capture-review-check" aria-hidden="true">
                <Check size={18} strokeWidth={3} />
              </span>
            </div>
            <span className="capture-review-badge"><CheckCircle2 size={13} /> Face Captured</span>
            <h3>Review Captured Photo</h3>
            <p className="view-modal-sub">Make sure the face is clearly visible before continuing.</p>
            <dl className="capture-review-info">
              <div>
                <User size={18} />
                <dt>Employee</dt>
                <dd className="capture-review-name">{selectedEmployee ? employeeLabel(selectedEmployee) : "—"}</dd>
              </div>
              <div>
                <Building2 size={18} />
                <dt>Department</dt>
                <dd>{selectedEmployee?.department?.name ?? "—"}</dd>
              </div>
              <div>
                <Calendar size={18} />
                <dt>Captured</dt>
                <dd>
                  {capturedAt.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
                  {" · "}
                  {capturedAt.toLocaleTimeString()}
                </dd>
              </div>
            </dl>
            <div className="view-modal-actions capture-review-actions">
              <button
                className="primary-button"
                onClick={saveEnrollment}
                disabled={busy || !verifiedSessionId}
              >
                <Check size={16} /> {busy ? "Registering..." : "Confirm & Register"}
              </button>
              <button
                className="outline-button"
                onClick={() => { setShowCapturePreview(false); resetCapture(); startCamera(); }}
                disabled={busy}
              >
                <RefreshCw size={16} /> Retake
              </button>
            </div>
          </div>
        </div>
      )}

      {viewProfile && (
        <div className="view-modal-overlay" onClick={closeViewModal}>
          {/* Same look as the capture review, in two columns so it fits
              without scrolling: photo, status and name on the left; details
              and actions on the right. */}
          <div className="view-modal capture-review-modal profile-modal" onClick={(event) => event.stopPropagation()}>
            <button className="view-modal-close capture-review-close" onClick={closeViewModal} aria-label="Close">
              <X size={15} />
            </button>
            <div className="profile-modal-side">
              {viewProfile.isArchived ? (
                <div className="view-modal-photo">
                  <div className="view-modal-photo-archived"><ScanFace size={56} /><span>Face archived</span></div>
                </div>
              ) : (
                <div className="capture-review-photo-wrap">
                  <button
                    type="button"
                    className="view-modal-photo capture-review-photo is-clickable"
                    onClick={() => setEnlargedPhoto(viewProfile.referenceImageData)}
                    aria-label="View registered photo full size"
                  >
                    <img src={viewProfile.referenceImageData ?? ""} alt={`Registered face for ${employeeLabel(viewProfile.employee)}`} />
                  </button>
                  <span className="capture-review-check" aria-hidden="true">
                    <Check size={18} strokeWidth={3} />
                  </span>
                </div>
              )}
              <span className={`capture-review-badge${viewProfile.isArchived ? " is-archived" : ""}`}>
                {viewProfile.isArchived ? <Archive size={13} /> : <CheckCircle2 size={13} />}
                {viewProfile.isArchived ? "Face Archived" : "Face Registered"}
              </span>
              <h3>{employeeLabel(viewProfile.employee)}</h3>
              <p className="view-modal-sub">
                {/* Department is listed in the details beside it. */}
                {viewProfile.employee.employmentStatus
                  ? EMPLOYMENT_STATUS_LABELS[viewProfile.employee.employmentStatus]
                  : "—"}
              </p>
            </div>
            <div className="profile-modal-main">
              <dl className="capture-review-info profile-info">
                {[
                  { icon: Mail, label: "Email", value: viewProfile.employee.user?.email ?? "—" },
                  { icon: Building2, label: "Department", value: viewProfile.employee.department?.name ?? "—" },
                  {
                    icon: Network,
                    label: "Supervisor",
                    value: viewProfile.employee.supervisor
                      ? `${viewProfile.employee.supervisor.firstName} ${viewProfile.employee.supervisor.lastName}`
                      : "None",
                  },
                  {
                    icon: MapPin,
                    label: "Attendance Mode",
                    value: formatAttendanceMode(viewProfile.employee.attendanceMode, attendanceModeOptions),
                  },
                  {
                    icon: Calendar,
                    label: "Registered On",
                    value: viewProfile.enrolledAt ? new Date(viewProfile.enrolledAt).toLocaleString() : "Pending",
                  },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label}>
                    <Icon size={18} />
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="view-modal-actions">
                <button className="primary-button" onClick={() => editProfilePhoto(viewProfile)}>
                  <Camera size={16} /> Re-register Face
                </button>
                {!viewProfile.isArchived && (
                  <button
                    className="archive-button"
                    onClick={() => { setArchiveTarget(viewProfile); closeViewModal(); }}
                  >
                    <Archive size={16} /> Archive
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <div className="delete-modal-overlay" onClick={() => (archiving ? null : setArchiveTarget(null))}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="view-modal-close"
              onClick={() => setArchiveTarget(null)}
              disabled={archiving}
              aria-label="Close"
            >
              <X size={18} />
            </button>
            <div className="archive-modal-icon">
              <Archive size={26} />
            </div>
            <h3>Archive Face Registration</h3>
            <p className="delete-modal-message">
              Are you sure you want to archive the face profile for{" "}
              <strong>{employeeLabel(archiveTarget.employee)}</strong>?
              <br />
              Only the face registration is archived — the employee record is kept and can be re-registered anytime.
              <br />
              <span className="delete-modal-id">
                {archiveTarget.employee.department?.name ?? "No department"}
              </span>
            </p>
            <div className="delete-modal-actions">
              <button className="archive-button" onClick={() => archiveEnrollment(archiveTarget.id)} disabled={archiving}>
                {archiving ? "Archiving..." : "Archive"}
              </button>
              <button className="outline-button" onClick={() => setArchiveTarget(null)} disabled={archiving}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {consentPending && selectedEmployee && consentDismissedFor !== selectedEmployee.id && (
        <div className="consent-modal-overlay">
          <div className="consent-modal">
            <button
              className="view-modal-close"
              onClick={() => setConsentDismissedFor(selectedEmployee.id)}
              aria-label="Close"
            >
              <X size={18} />
            </button>
            <div className="consent-modal-icon">
              <AlertTriangle size={26} />
            </div>
            <h3>Employee Consent Required</h3>
            <p className="consent-modal-desc">
              This employee has not yet accepted the face-data consent. Please have the employee log in to
              the mobile app and accept the consent before proceeding with face registration.
            </p>
            <p className="consent-modal-sub">
              {employeeLabel(selectedEmployee)} · {formatEmploymentStatus(selectedEmployee.employmentStatus)}
            </p>
            <button
              className="primary-button consent-modal-btn"
              onClick={refreshConsentStatus}
              disabled={consentRefreshing}
            >
              {consentRefreshing ? "Checking..." : "Check Again"}
            </button>
          </div>
        </div>
      )}
      {enlargedPhoto && (
        <div className="photo-lightbox" role="dialog" aria-label="Face photo" onClick={() => setEnlargedPhoto(null)}>
          <img src={enlargedPhoto} alt="Face photo, full size" />
          <button type="button" className="photo-lightbox-close" aria-label="Close">
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
