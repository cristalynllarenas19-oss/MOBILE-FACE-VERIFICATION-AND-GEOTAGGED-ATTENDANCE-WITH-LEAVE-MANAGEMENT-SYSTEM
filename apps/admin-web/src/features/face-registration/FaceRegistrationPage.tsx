import * as faceapi from "face-api.js";
import { AlertTriangle, Archive, Camera, CheckCircle2, Eye, Pencil, RotateCcw, ScanFace, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../../lib/api";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { Badge } from "../../components/ui/Badge";
import { useActiveDepartments } from "../../lib/departments";
import { formatAttendanceMode, useAttendanceModeOptions } from "../../lib/attendanceModes";
import { EMPLOYMENT_STATUS_LABELS } from "../../types/employment";
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
  confidence: number;
  width: number;
  height: number;
  x: number;
  y: number;
  boxWidth: number;
  boxHeight: number;
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
  employmentStatus?: "REGULAR" | "PROBATIONARY" | "CONTRACTUAL_SEASONAL" | "PIECE_RATE" | "SEPARATED";
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
  employee: Employee;
};

const MODEL_URL = "/models";
const CAMERA_SAMPLE_TARGET = 1;
const COUNTDOWN_SECONDS = 2;

const CAPTURE_STEPS = [
  {
    key: "front",
    title: "Look at the camera",
    helper: "Keep the face centered inside the guide.",
  },
] as const;

function employeeLabel(employee: Employee) {
  return `${employee.firstName} ${employee.lastName}`;
}

// face-api.js ships no dedicated eyewear classifier, so this is a best-effort
// pixel heuristic built on the 68-point landmarks we already compute for
// detection/tracking — not a trained model. It looks for two independent
// signals around the eyes and flags either one:
//  1. Frame edges — clear/rimmed glasses leave a strong edge across the nose
//     bridge and around the eye sockets that bare skin doesn't produce
//     (measured via Sobel gradient magnitude).
//  2. Lens darkness — sunglasses make the eye region noticeably darker than
//     the forehead just above it (measured via average luminance delta).
// EYEGLASS_EDGE_THRESHOLD / SUNGLASSES_DARKNESS_THRESHOLD are starting points,
// not calibrated against real footage — expect to retune them (and accept
// some false positives/negatives, especially for thin rimless frames, which
// barely register on signal 1) once this runs against real captures.
const EYEGLASS_EDGE_THRESHOLD = 12; // % of bridge-band pixels counted as a strong edge
const SUNGLASSES_DARKNESS_THRESHOLD = 35; // forehead-vs-eye average brightness delta (0-255 scale)
const ENROLLMENTS_PAGE_SIZE = 5;

function pointsBounds(points: faceapi.Point[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function detectEyewear(video: HTMLVideoElement, landmarks: faceapi.FaceLandmarks68): boolean {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const leftBrow = landmarks.getLeftEyeBrow();
  const rightBrow = landmarks.getRightEyeBrow();
  if (!leftEye.length || !rightEye.length || !leftBrow.length || !rightBrow.length) return false;

  const eyeBounds = pointsBounds([...leftEye, ...rightEye]);
  const browBounds = pointsBounds([...leftBrow, ...rightBrow]);
  const browHeight = eyeBounds.minY - browBounds.minY || 12;

  // Crop from just above the eyebrows (approximating the forehead, since the
  // 68-point set has no forehead landmarks of its own) down to just below
  // the eyes, spanning the full eye+brow width with a little side padding.
  const padX = (eyeBounds.maxX - eyeBounds.minX) * 0.1;
  const cropX = Math.max(0, eyeBounds.minX - padX);
  const cropY = Math.max(0, browBounds.minY - browHeight);
  const cropWidth = Math.min(video.videoWidth - cropX, eyeBounds.maxX - eyeBounds.minX + padX * 2);
  const cropHeight = Math.min(video.videoHeight - cropY, eyeBounds.maxY - cropY + browHeight * 0.4);
  if (cropWidth < 20 || cropHeight < 12) return false;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropWidth);
  canvas.height = Math.round(cropHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);

  const { data, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // Signal 1: edge density across the eye-level band (roughly the middle
  // third of the crop, where a glasses frame/bridge would sit).
  const bandTop = Math.max(1, Math.round(h * 0.35));
  const bandBottom = Math.min(h - 1, Math.round(h * 0.7));
  let strongEdges = 0;
  let bandPixels = 0;
  for (let py = Math.max(1, bandTop); py < bandBottom; py++) {
    for (let px = 1; px < w - 1; px++) {
      const gx =
        -gray[(py - 1) * w + (px - 1)] + gray[(py - 1) * w + (px + 1)] +
        -2 * gray[py * w + (px - 1)] + 2 * gray[py * w + (px + 1)] +
        -gray[(py + 1) * w + (px - 1)] + gray[(py + 1) * w + (px + 1)];
      const gy =
        -gray[(py - 1) * w + (px - 1)] - 2 * gray[(py - 1) * w + px] - gray[(py - 1) * w + (px + 1)] +
        gray[(py + 1) * w + (px - 1)] + 2 * gray[(py + 1) * w + px] + gray[(py + 1) * w + (px + 1)];
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude > 110) strongEdges++;
      bandPixels++;
    }
  }
  const edgeDensity = bandPixels > 0 ? (strongEdges / bandPixels) * 100 : 0;

  // Signal 2: forehead strip (top ~20%) vs eye-band average brightness.
  const foreheadEnd = Math.max(1, Math.round(h * 0.2));
  let foreheadSum = 0;
  let foreheadCount = 0;
  for (let i = 0; i < foreheadEnd * w; i++) {
    foreheadSum += gray[i];
    foreheadCount++;
  }
  let eyeBandSum = 0;
  let eyeBandCount = 0;
  for (let py = bandTop; py < bandBottom; py++) {
    for (let px = 0; px < w; px++) {
      eyeBandSum += gray[py * w + px];
      eyeBandCount++;
    }
  }
  const foreheadAvg = foreheadCount > 0 ? foreheadSum / foreheadCount : 0;
  const eyeBandAvg = eyeBandCount > 0 ? eyeBandSum / eyeBandCount : 0;
  const darknessDelta = foreheadAvg - eyeBandAvg;

  return edgeDensity > EYEGLASS_EDGE_THRESHOLD || darknessDelta > SUNGLASSES_DARKNESS_THRESHOLD;
}

export function FaceRegistrationPage({ initialEmployee }: { initialEmployee?: FaceRegistrationEmployee } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(false);
  const countdownTimerRef = useRef<number | null>(null);
  const faceTrackingTimerRef = useRef<number | null>(null);
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
  const [captureStepIndex, setCaptureStepIndex] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [faceFrame, setFaceFrame] = useState<FaceFrame | null>(null);
  const [eyewearDetected, setEyewearDetected] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showCapturePreview, setShowCapturePreview] = useState(false);
  const [lastRegisteredEmployee, setLastRegisteredEmployee] = useState<Employee | null>(null);
  const [lastActionWasEdit, setLastActionWasEdit] = useState(false);
  const [listDepartmentFilter, setListDepartmentFilter] = useState<string>("ALL");
  const [listModeFilter, setListModeFilter] = useState<"ALL" | "FIELD" | "FIXED">("ALL");
  const [listSearch, setListSearch] = useState("");
  const [enrollmentsPage, setEnrollmentsPage] = useState(1);
  const [viewProfile, setViewProfile] = useState<FaceProfile | null>(null);
  const [editingEnrollmentId, setEditingEnrollmentId] = useState<string | null>(null);
  const captureCardRef = useRef<HTMLDivElement>(null);
  const [archiveTarget, setArchiveTarget] = useState<FaceProfile | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [consentRefreshing, setConsentRefreshing] = useState(false);

  useEffect(() => {
    Promise.all([
      apiRequest<FaceProfile[]>("/face-profiles"),
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
      .then(([faceProfiles]) => {
        setEnrollments(faceProfiles);
        setModelsReady(true);
        setMessage(
          initialEmployee
            ? `Employee added successfully. Start the camera to register ${employeeLabel(initialEmployee)}'s face.`
            : "",
        );
      })
      .catch(() => setMessage("Employee or face models could not be loaded. Refresh the page and try again."));

    return () => {
      clearCountdownTimer();
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
      setCaptureStepIndex(0);
      setCountdown(null);
      setFaceFrame(null);
      setEyewearDetected(false);
    } catch {
      setMessage("Camera access was denied or no camera is available.");
    }
  }

  function stopCamera() {
    sequenceRef.current = false;
    clearCountdownTimer();
    stopFaceTracking();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
    setBusy(false);
    setCountdown(null);
    setFaceFrame(null);
    setEyewearDetected(false);
  }

  function clearCountdownTimer() {
    if (countdownTimerRef.current) {
      window.clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
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
    // Belt-and-suspenders: the live tracker already blocks starting a guided
    // capture while eyewear is detected, but re-check the actual captured
    // frame in case the on-screen state was stale at the moment of capture.
    if (input instanceof HTMLVideoElement && detectEyewear(input, results[0].landmarks)) {
      throw new Error("Eyeglasses or sunglasses detected. Please remove them and try again.");
    }
    return Array.from(results[0].descriptor);
  }

  function startFaceTracking() {
    if (!modelsReady || faceTrackingTimerRef.current) return;

    faceTrackingTimerRef.current = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      try {
        const result = await faceapi
          .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 }))
          .withFaceLandmarks(true);

        if (!result) {
          setFaceFrame(null);
          setEyewearDetected(false);
          return;
        }

        setEyewearDetected(detectEyewear(video, result.landmarks));

        const scale = Math.max(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
        const renderedWidth = video.videoWidth * scale;
        const renderedHeight = video.videoHeight * scale;
        const cropX = (renderedWidth - video.clientWidth) / 2;
        const cropY = (renderedHeight - video.clientHeight) / 2;
        const box = result.detection.box;
        const padX = box.width * 0.08;
        const padY = box.height * 0.12;
        const x = Math.max(0, (box.x * scale) - cropX - padX);
        const y = Math.max(0, (box.y * scale) - cropY - padY);
        const boxWidth = Math.min(video.clientWidth - x, box.width * scale + padX * 2);
        const boxHeight = Math.min(video.clientHeight - y, box.height * scale + padY * 2);

        setFaceFrame({
          confidence: result.detection.score,
          width: video.clientWidth,
          height: video.clientHeight,
          x,
          y,
          boxWidth,
          boxHeight,
        });
      } catch {
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

  function waitForCountdown(stepIndex: number) {
    return new Promise<void>((resolve) => {
      let seconds = COUNTDOWN_SECONDS;
      setCaptureStepIndex(stepIndex);
      setCountdown(seconds);
      setMessage(`${CAPTURE_STEPS[stepIndex].title}. Capturing in ${seconds} seconds.`);

      const tick = () => {
        seconds -= 1;
        if (!sequenceRef.current) return;
        if (seconds <= 0) {
          setCountdown(null);
          resolve();
          return;
        }
        setCountdown(seconds);
        setMessage(`${CAPTURE_STEPS[stepIndex].title}. Capturing in ${seconds} seconds.`);
        countdownTimerRef.current = window.setTimeout(tick, 1000);
      };

      countdownTimerRef.current = window.setTimeout(tick, 1000);
    });
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
    setMessage("Guided capture started. Follow each prompt and hold steady.");

    try {
      for (let index = 0; index < CAPTURE_STEPS.length; index += 1) {
        await waitForCountdown(index);
        if (!sequenceRef.current) return;
        await captureCurrentFrame();
        setMessage(`${CAPTURE_STEPS[index].title} sample captured.`);
        await new Promise((resolve) => {
          countdownTimerRef.current = window.setTimeout(resolve, 700);
        });
      }

      sequenceRef.current = false;
      setCaptureStepIndex(CAPTURE_STEPS.length - 1);
      stopCamera();
      setMessage("");
      setShowCapturePreview(true);
    } catch (error) {
      sequenceRef.current = false;
      setCountdown(null);
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
    clearCountdownTimer();
    setShowCapturePreview(false);
    setDescriptors([]);
    setPreview("");
    setCaptureStepIndex(0);
    setCountdown(null);
    setFaceFrame(null);
    setBusy(false);
    setMessage(cameraActive ? "Capture reset. Begin the guided capture again." : "Start the camera for a guided face capture.");
  }

  function saveEnrollment() {
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
    try {
      const employeeToRegister = selectedEmployee;
      const enrollmentIdBeingEdited = editingEnrollmentId;
      // The backend upserts by employee: an active profile gets replaced in
      // place, so re-registration never stacks duplicate rows.
      const wasReRegistration = Boolean(
        enrollmentIdBeingEdited || enrollments.some((item) => item.employeeId === employeeToRegister.id),
      );
      apiRequest<FaceProfile>("/face-profiles", {
        method: "POST",
        body: JSON.stringify({
          employeeId: employeeToRegister.id,
          referenceImageData: preview,
          descriptors,
        }),
      }).then((saved) => {
        setEnrollments((current) =>
          current.some((item) => item.id === saved.id)
            ? current.map((item) => (item.id === saved.id ? saved : item))
            : [saved, ...current],
        );
        setLastRegisteredEmployee(employeeToRegister);
        setLastActionWasEdit(wasReRegistration);
        setShowSuccessModal(true);
      });
      // Registering the handed-over employee ends the locked handoff; an edit
      // done while the handoff is still pending re-selects them instead.
      const handoffPending = Boolean(initialEmployee && !handoffCompleted);
      if (!enrollmentIdBeingEdited && handoffPending) setHandoffCompleted(true);
      setSelectedEmployee(enrollmentIdBeingEdited && handoffPending ? initialEmployee! : null);
      setEditingEnrollmentId(null);
      setDescriptors([]);
      setPreview("");
      setCaptureStepIndex(0);
      setCountdown(null);
      setFaceFrame(null);
      stopCamera();
    } catch {
      setMessage("Unable to register the face profile. Check the backend connection and try again.");
    }
  }

  function archiveEnrollment(id: string) {
    setArchiving(true);
    apiRequest(`/face-profiles/${id}/archive`, { method: "PATCH", body: JSON.stringify({}) })
      .then(() => {
        setEnrollments((current) => current.filter((item) => item.id !== id));
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

  const enrollmentModeCounts = {
    all: enrollmentsBeforeModeFilter.length,
    field: enrollmentsBeforeModeFilter.filter((item) => item.employee.attendanceMode === "FIELD").length,
    fixed: enrollmentsBeforeModeFilter.filter((item) => item.employee.attendanceMode !== "FIELD").length,
  };

  const visibleEnrollments =
    listModeFilter === "ALL"
      ? enrollmentsBeforeModeFilter
      : enrollmentsBeforeModeFilter.filter((item) =>
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

  const selectedEnrollment = selectedEmployee
    ? enrollments.find((item) => item.employeeId === selectedEmployee.id) ?? null
    : null;

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
          {/* The handoff view already recaps the new employee next to the
              camera, so the summary tiles would only repeat it. */}
          {!isPreselectedNewEmployee && (
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
                <span className="stat-value">{enrollments.length}</span>
                <span className="stat-label">Registered Employees</span>
              </div>
            </div>
          )}

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
                  className="face-guide-rect"
                  x={faceFrame.x}
                  y={faceFrame.y}
                  width={faceFrame.boxWidth}
                  height={faceFrame.boxHeight}
                  rx="18"
                  ry="18"
                />
                <text x="14" y="24">{Math.round(faceFrame.confidence * 100)}%</text>
              </svg>
            )}
            {cameraActive && countdown !== null && (
              <div className="capture-overlay">
                <strong>{countdown}</strong>
                <small>{CAPTURE_STEPS[captureStepIndex].helper}</small>
              </div>
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
                  <div className="success-modal-icon">
                    <CheckCircle2 size={48} />
                  </div>
                  <h3>{lastActionWasEdit ? "Face Photo Updated" : "Face Registered Successfully"}</h3>
                  <p className="success-modal-name">{employeeLabel(lastRegisteredEmployee)}</p>
                  <p className="success-modal-sub">{lastRegisteredEmployee.employeeNo} · {lastRegisteredEmployee.department?.name ?? "No department"}</p>
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
              <h3>{editingEnrollmentId ? "Update Face Photo" : selectedEmployee ? "New Employee" : "No Employee Selected"}</h3>
            </div>
          </div>

          {editingEnrollmentId && (
            <p className="capture-message">Capture a new photo below for this employee, then save to replace their existing photo.</p>
          )}

          {selectedEmployee ? (
            <div className="selected-employee-card new-employee-details reregister-details">
              <div className="new-employee-details-name">
                <p>{editingEnrollmentId ? "Editing photo for" : "New employee"}</p>
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
            <div className="registered-mode-tabs" role="tablist" aria-label="Filter registered employees by attendance mode">
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
              <p className="empty-enrollments">No registered employees match this search or filter.</p>
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
                          <Badge tone={enrollmentStatusTone(item.enrollmentStatus)}>{item.enrollmentStatus}</Badge>
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
        // must be resolved with "Looks Good" or "Retake" — not dismissed.
        <div className="view-modal-overlay" onClick={isPreselectedNewEmployee ? undefined : closeCapturePreview}>
          <div className="view-modal" onClick={(event) => event.stopPropagation()}>
            {!isPreselectedNewEmployee && (
              <button className="view-modal-close" onClick={closeCapturePreview} aria-label="Close">
                <X size={18} />
              </button>
            )}
            <div className="view-modal-photo capture-preview-photo">
              <img src={preview} alt="Captured face preview" />
            </div>
            <h3>Captured Photo</h3>
            <p className="view-modal-sub">Review the captured image. Close this preview to continue.</p>
            <div className="view-modal-actions">
              <button
                className="primary-button"
                onClick={() => { setShowCapturePreview(false); saveEnrollment(); }}
              >
                <CheckCircle2 size={16} /> Looks Good
              </button>
              <button
                className="outline-button"
                onClick={() => { setShowCapturePreview(false); resetCapture(); startCamera(); }}
              >
                <RotateCcw size={16} /> Retake
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
              <img src={viewProfile.referenceImageData ?? ""} alt={`Registered face for ${employeeLabel(viewProfile.employee)}`} />
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
                <dd>{viewProfile.enrollmentStatus}</dd>
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
              <button
                className="archive-button"
                onClick={() => { setArchiveTarget(viewProfile); closeViewModal(); }}
              >
                <Archive size={16} /> Archive
              </button>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <div className="delete-modal-overlay" onClick={() => (archiving ? null : setArchiveTarget(null))}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="archive-modal-icon">
              <Archive size={26} />
            </div>
            <h3>Archive Face Registration</h3>
            <p className="delete-modal-message">
              Are you sure you want to archive the face profile for{" "}
              <strong>{employeeLabel(archiveTarget.employee)}</strong>?
              <br />
              This removes them from the registered employees list until re-registered.
              <br />
              <span className="delete-modal-id">
                {archiveTarget.employee.employeeNo} · {archiveTarget.employee.department?.name ?? "No department"}
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

      {consentPending && selectedEmployee && (
        <div className="consent-modal-overlay">
          <div className="consent-modal">
            <div className="consent-modal-icon">
              <AlertTriangle size={26} />
            </div>
            <h3>Employee Consent Required</h3>
            <p className="consent-modal-desc">
              This employee has not yet accepted the face-data consent. Please have the employee log in to
              the mobile app and accept the consent before proceeding with face registration.
            </p>
            <p className="consent-modal-sub">
              {employeeLabel(selectedEmployee)} · {selectedEmployee.employeeNo}
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