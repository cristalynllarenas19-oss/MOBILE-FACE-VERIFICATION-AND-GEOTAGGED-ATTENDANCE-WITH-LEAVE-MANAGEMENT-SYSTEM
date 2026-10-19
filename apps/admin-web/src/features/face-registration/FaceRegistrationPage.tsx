import * as faceapi from "face-api.js";
import { AlertTriangle, Archive, Building2, Calendar, Camera, Check, CheckCircle2, Eye, Pencil, RefreshCw, RotateCcw, ScanFace, Search, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../lib/api";
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
  // guide box turning green.
  ready: boolean;
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

const CAPTURE_STEPS = [
  {
    key: "front",
    title: "Look at the camera",
  },
] as const;

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

export function FaceRegistrationPage({ initialEmployee }: { initialEmployee?: FaceRegistrationEmployee } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(false);
  const faceTrackingTimerRef = useRef<number | null>(null);
  // Eyewear verdicts of the most recent polls — see EYEWEAR_WINDOW.
  const eyewearHistoryRef = useRef<boolean[]>([]);
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
        setMessage(
          initialEmployee
            ? faceProfiles.some((item) => item.employeeId === initialEmployee.id)
              ? `Start the camera to register ${employeeLabel(initialEmployee)}'s face.`
              : `Employee added successfully. Start the camera to register ${employeeLabel(initialEmployee)}'s face.`
            : "",
        );
      })
      .catch(() => setMessage("Employee or face models could not be loaded. Refresh the page and try again."));

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
    if (selectedEmployee?.requiresFaceConsent && !selectedEmployee.faceConsentAcceptedAt) return;
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      setDescriptors([]);
      setPreview("");
      setFaceFrame(null);
      setEyewearDetected(false);
    } catch {
      setMessage("Camera access was denied or no camera is available.");
    }
  }

  function stopCamera() {
    sequenceRef.current = false;
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

  function startFaceTracking() {
    if (!modelsReady || faceTrackingTimerRef.current) return;
    eyewearHistoryRef.current = [];

    faceTrackingTimerRef.current = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      try {
        const result = await faceapi
          .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 }))
          .withFaceLandmarks(true);

        if (!result) {
          eyewearHistoryRef.current = [];
          setFaceFrame(null);
          setEyewearDetected(false);
          return;
        }

        eyewearHistoryRef.current = [...eyewearHistoryRef.current, detectEyewear(video, result.landmarks)].slice(
          -EYEWEAR_WINDOW,
        );
        setEyewearDetected(isEyewearConfirmed(eyewearHistoryRef.current));

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
        const ready =
          result.detection.score >= 0.75 && box.width >= 120 && box.height >= 120;

        setFaceFrame({
          width: video.clientWidth,
          height: video.clientHeight,
          x,
          y,
          boxWidth,
          boxHeight,
          ready,
        });
      } catch {
        eyewearHistoryRef.current = [];
        setFaceFrame(null);
        setEyewearDetected(false);
      }
    }, 250);
  }

  function stopFaceTracking() {
    if (faceTrackingTimerRef.current) {
      window.clearInterval(faceTrackingTimerRef.current);
      faceTrackingTimerRef.current = null;
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
  }

  async function startGuidedCapture() {
    if (!cameraActive || busy) return;
    if (eyewearDetected) {
      setMessage("Eyeglasses or sunglasses detected. Please remove them before capturing.");
      return;
    }
    sequenceRef.current = true;
    setBusy(true);
    setDescriptors([]);
    setPreview("");
    setMessage("Capturing...");

    try {
      for (let index = 0; index < CAPTURE_STEPS.length; index += 1) {
        if (!sequenceRef.current) return;
        await captureCurrentFrame();
        setMessage(`${CAPTURE_STEPS[index].title} sample captured.`);
      }

      sequenceRef.current = false;
      stopCamera();
      setMessage("");
      setShowCapturePreview(true);
    } catch (error) {
      sequenceRef.current = false;
      setMessage(error instanceof Error ? error.message : "Face capture failed.");
    } finally {
      setBusy(false);
    }
  }

  function closeCapturePreview() {
    setShowCapturePreview(false);
    setMessage("Guided face capture complete. Review the details and register the employee.");
  }

  function resetCapture() {
    sequenceRef.current = false;
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
    if (!preview || descriptors.length < CAMERA_SAMPLE_TARGET) {
      setMessage("Capture the face sample before registering.");
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
      const saved = await apiRequest<FaceProfile>("/face-profiles", {
        method: "POST",
        body: JSON.stringify({
          employeeId: employeeToRegister.id,
          referenceImageData: preview,
          descriptors,
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
      setFaceFrame(null);
      stopCamera();
    } catch {
      setMessage("Unable to register the face profile. Check the backend connection and try again.");
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

  return (
    <div className="face-page">
      <div className="face-workspace">
        <section className="face-card capture-card" ref={captureCardRef}>
          <div className="capture-summary">
            <div>
              <p>{editingEnrollmentId ? "Editing photo for" : "Selected employee"}</p>
              <strong>{selectedEmployee ? employeeLabel(selectedEmployee) : "None selected"}</strong>
            </div>
            <div>
              <p>Status</p>
              <strong
                className={
                  cameraActive ? (faceFrame && !eyewearDetected ? "status-face-detected" : "status-face-missing") : undefined
                }
              >
                {cameraActive
                  ? eyewearDetected
                    ? "Remove eyeglasses"
                    : faceFrame
                      ? "Face detected"
                      : "No face detected"
                  : selectedEmployee
                    ? "Ready for capture"
                    : "Choose an employee first"}
              </strong>
            </div>
            <div className="stat-inline-card">
              <span className="stat-value">{enrollments.filter((item) => !item.isArchived).length}</span>
              <span className="stat-label">Registered Employees</span>
            </div>
          </div>

          <div className="capture-stage">
            {cameraActive ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : preview ? (
              <img src={preview} alt="Face enrollment preview" />
            ) : (
              <div className="capture-placeholder"><ScanFace size={72} /><span>No face captured</span></div>
            )}
            {cameraActive && faceFrame && (
              <svg className="face-tracker" viewBox={`0 0 ${faceFrame.width} ${faceFrame.height}`} aria-hidden="true">
                <rect
                  className={`face-guide-rect${faceFrame.ready && !eyewearDetected ? " is-ready" : ""}`}
                  x={faceFrame.x}
                  y={faceFrame.y}
                  width={faceFrame.boxWidth}
                  height={faceFrame.boxHeight}
                  rx="18"
                  ry="18"
                />
              </svg>
            )}
            {cameraActive && eyewearDetected && (
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
              disabled={!modelsReady || busy || (cameraActive && eyewearDetected)}
            >
              <Camera size={17} /> {busy ? "Capturing automatically..." : cameraActive ? "Start guided capture" : "Start camera"}
            </button>
            <button className="outline-button" onClick={resetCapture} disabled={busy || (!cameraActive && descriptors.length === 0)}>
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
          </div>

          {editingEnrollmentId && (
            <p className="capture-message">Capture a new photo below for this employee, then save to replace their existing photo.</p>
          )}

          {selectedEmployee ? (
            <div className="selected-employee-card new-employee-details reregister-details">
              <div className="new-employee-details-name">
                <p>{editingEnrollmentId ? "Editing photo for" : selectedFaceArchived ? "Selected employee" : "New employee"}</p>
                <strong>{employeeLabel(selectedEmployee)}</strong>
              </div>
              <div>
                <p>Email</p>
                <strong>{selectedEmployee.user?.email ?? "—"}</strong>
              </div>
              <div>
                <p>Department</p>
                <strong>{selectedEmployee.department?.name ?? "—"}</strong>
              </div>
              <div>
                <p>Supervisor</p>
                <strong>
                  {selectedEmployee.supervisor
                    ? `${selectedEmployee.supervisor.firstName} ${selectedEmployee.supervisor.lastName}`
                    : "None"}
                </strong>
              </div>
              <div>
                <p>Hire Date</p>
                <strong>
                  {selectedEmployee.hireDate ? new Date(selectedEmployee.hireDate).toLocaleDateString() : "—"}
                </strong>
              </div>
              <div>
                <p>Employment Status</p>
                <strong>
                  {selectedEmployee.employmentStatus ? EMPLOYMENT_STATUS_LABELS[selectedEmployee.employmentStatus] : "—"}
                </strong>
              </div>
              <div>
                <p>Attendance Mode</p>
                <strong>{formatAttendanceMode(selectedEmployee.attendanceMode, attendanceModeOptions)}</strong>
              </div>
              <div>
                <p>Face Registration</p>
                <strong>
                  {selectedEnrollment
                    ? selectedEnrollment.enrolledAt
                      ? `Registered · ${new Date(selectedEnrollment.enrolledAt).toLocaleDateString()}`
                      : "Registered"
                    : selectedFaceArchived
                      ? "Archived · not registered"
                      : "Not yet registered"}
                </strong>
              </div>
            </div>
          ) : (
            <p className="capture-message">
              New employees are sent here automatically from Employee Management. To re-register an existing
              employee's face, use the "Re-register" action from the list below.
            </p>
          )}

          <div className="form-actions">
            {/* In the handoff view the face is saved from the capture
                preview's "Looks Good" button, so no register button here. */}
            {!isPreselectedNewEmployee && (
              <button
                className="primary-button save-face-button"
                onClick={saveEnrollment}
                disabled={busy || descriptors.length < CAMERA_SAMPLE_TARGET || !selectedEmployee}
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
            <div className="view-modal-photo capture-review-photo">
              <img src={preview} alt="Captured face preview" />
            </div>
            <span className="capture-review-badge"><Camera size={13} /> Face Captured</span>
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
                disabled={busy}
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
          <div className="view-modal" onClick={(event) => event.stopPropagation()}>
            <button className="view-modal-close" onClick={closeViewModal} aria-label="Close">
              <X size={18} />
            </button>

            <div className="view-modal-photo">
              {viewProfile.isArchived ? (
                <div className="view-modal-photo-archived"><ScanFace size={56} /><span>Face archived</span></div>
              ) : (
                <img src={viewProfile.referenceImageData ?? ""} alt={`Registered face for ${employeeLabel(viewProfile.employee)}`} />
              )}
            </div>
            <h3>{employeeLabel(viewProfile.employee)}</h3>
            <p className="view-modal-sub">
              {viewProfile.employee.employmentStatus
                ? EMPLOYMENT_STATUS_LABELS[viewProfile.employee.employmentStatus]
                : "—"}
              {" · "}
              {viewProfile.employee.department?.name ?? "No department"}
            </p>
            <dl className="view-modal-details">
              <div>
                <dt>Status</dt>
                <dd>{viewProfile.isArchived ? "ARCHIVED" : viewProfile.enrollmentStatus}</dd>
              </div>
              <div>
                <dt>Date of Registration</dt>
                <dd>{viewProfile.enrolledAt ? new Date(viewProfile.enrolledAt).toLocaleString() : "Pending"}</dd>
              </div>
            </dl>
            <div className="view-modal-actions">
              <button className="primary-button" onClick={() => editProfilePhoto(viewProfile)}>
                <Pencil size={16} /> Re-register Face
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
    </div>
  );
}
