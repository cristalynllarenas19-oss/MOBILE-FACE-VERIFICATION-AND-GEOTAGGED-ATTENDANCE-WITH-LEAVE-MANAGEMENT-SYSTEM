import * as faceapi from "face-api.js";
import { Camera, CheckCircle2, Circle, RotateCcw, ScanFace, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  faceOutline: string;
  meshLines: string[];
  jaw: string;
  leftBrow: string;
  rightBrow: string;
  noseBridge: string;
  noseBase: string;
  leftEye: string;
  rightEye: string;
  outerMouth: string;
  innerMouth: string;
};

const MODEL_URL = "/models";
const CAMERA_SAMPLE_TARGET = 3;
const STORAGE_KEY = "employeeFaceEnrollments";
const COUNTDOWN_SECONDS = 3;

const CAPTURE_STEPS = [
  {
    key: "front",
    title: "Look at the camera",
    helper: "Keep the face centered inside the guide.",
  },
  {
    key: "left",
    title: "Look left",
    helper: "Turn the head slightly to the employee's left.",
  },
  {
    key: "right",
    title: "Look right",
    helper: "Turn the head slightly to the employee's right.",
  },
] as const;

const FACE_MESH_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8],
  [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20], [20, 21], [22, 23], [23, 24], [24, 25], [25, 26],
  [27, 28], [28, 29], [29, 30], [30, 33], [31, 32], [32, 33], [33, 34], [34, 35],
  [36, 37], [37, 38], [38, 39], [39, 40], [40, 41], [41, 36],
  [42, 43], [43, 44], [44, 45], [45, 46], [46, 47], [47, 42],
  [48, 49], [49, 50], [50, 51], [51, 52], [52, 53], [53, 54],
  [54, 55], [55, 56], [56, 57], [57, 58], [58, 59], [59, 48],
  [60, 61], [61, 62], [62, 63], [63, 64], [64, 65], [65, 66], [66, 67], [67, 60],
  [0, 17], [1, 17], [2, 18], [3, 19], [4, 20], [5, 31], [6, 48], [7, 59],
  [8, 57], [9, 55], [10, 54], [11, 35], [12, 25], [13, 26], [14, 26], [16, 26],
  [17, 27], [18, 27], [19, 28], [20, 28], [21, 27], [21, 39],
  [22, 27], [22, 42], [23, 28], [24, 28], [25, 35], [26, 35],
  [27, 36], [27, 42], [28, 39], [28, 42], [29, 31], [29, 35],
  [30, 31], [30, 35], [31, 48], [32, 50], [33, 51], [34, 52], [35, 54],
  [36, 48], [37, 49], [38, 50], [39, 51], [40, 31], [41, 48],
  [42, 54], [43, 53], [44, 52], [45, 54], [46, 35], [47, 54],
  [48, 60], [49, 60], [50, 61], [51, 62], [52, 63], [53, 64],
  [54, 64], [55, 65], [56, 66], [57, 66], [58, 67], [59, 60],
  [0, 36], [0, 41], [1, 36], [1, 41], [2, 36], [2, 31],
  [3, 31], [3, 48], [4, 48], [4, 59], [5, 48], [5, 59],
  [6, 59], [6, 58], [7, 58], [7, 57], [8, 56], [8, 58],
  [9, 56], [9, 55], [10, 55], [10, 54], [11, 54], [11, 35],
  [12, 35], [12, 45], [13, 45], [13, 46], [14, 46], [14, 47],
  [15, 42], [15, 47], [16, 42], [16, 47], [17, 36], [18, 37],
  [19, 38], [20, 39], [21, 39], [22, 42], [23, 43], [24, 44],
  [25, 45], [26, 45], [31, 36], [31, 41], [32, 40], [32, 49],
  [33, 39], [33, 42], [33, 51], [33, 62], [34, 46], [34, 53],
  [35, 42], [35, 47], [36, 49], [37, 50], [38, 51], [39, 51],
  [40, 49], [41, 48], [42, 53], [43, 52], [44, 51], [45, 53],
  [46, 54], [47, 54], [48, 61], [49, 61], [50, 62], [51, 63],
  [52, 63], [53, 64], [55, 64], [56, 65], [57, 67], [58, 60],
] as const;

function readEnrollments(): Enrollment[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Enrollment[];
  } catch {
    return [];
  }
}

export function FaceRegistrationPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(false);
  const countdownTimerRef = useRef<number | null>(null);
  const faceTrackingTimerRef = useRef<number | null>(null);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [department, setDepartment] = useState("");
  const [descriptors, setDescriptors] = useState<number[][]>([]);
  const [preview, setPreview] = useState("");
  const [enrollments, setEnrollments] = useState<Enrollment[]>(readEnrollments);
  const [message, setMessage] = useState("Loading face recognition models...");
  const [busy, setBusy] = useState(false);
  const [captureStepIndex, setCaptureStepIndex] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [faceFrame, setFaceFrame] = useState<FaceFrame | null>(null);

  useEffect(() => {
    Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
      .then(() => {
        setModelsReady(true);
        setMessage("Models ready. Start the camera for a guided front, left, and right capture.");
      })
      .catch(() => setMessage("Face models could not be loaded. Refresh the page and try again."));

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
      setMessage("Camera ready. Begin the guided capture when the employee is positioned.");
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
          return;
        }

        const scale = Math.max(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
        const renderedWidth = video.videoWidth * scale;
        const renderedHeight = video.videoHeight * scale;
        const cropX = (renderedWidth - video.clientWidth) / 2;
        const cropY = (renderedHeight - video.clientHeight) / 2;
        const toScreenPoint = (point: faceapi.Point) => ({
          x: video.clientWidth - (point.x * scale - cropX),
          y: point.y * scale - cropY,
        });
        const toPointString = (points: faceapi.Point[]) =>
          points
            .map((point) => {
              const screenPoint = toScreenPoint(point);
              return `${screenPoint.x},${screenPoint.y}`;
            })
            .join(" ");
        const landmarkPoints = result.landmarks.positions.map(toScreenPoint);
        const jawPoints = result.landmarks.getJawOutline().map(toScreenPoint);
        const leftBrowPoints = result.landmarks.getLeftEyeBrow().map(toScreenPoint);
        const rightBrowPoints = result.landmarks.getRightEyeBrow().map(toScreenPoint);
        const browPoints = [...leftBrowPoints, ...rightBrowPoints];
        const minX = Math.min(...jawPoints.map((point) => point.x));
        const maxX = Math.max(...jawPoints.map((point) => point.x));
        const browTop = Math.min(...browPoints.map((point) => point.y));
        const jawHeight = Math.max(...jawPoints.map((point) => point.y)) - browTop;
        const foreheadTop = browTop - jawHeight * 0.34;
        const faceOutlinePoints = [
          ...jawPoints,
          { x: maxX - (maxX - minX) * 0.08, y: browTop - jawHeight * 0.08 },
          { x: maxX - (maxX - minX) * 0.28, y: foreheadTop },
          { x: (minX + maxX) / 2, y: foreheadTop - jawHeight * 0.04 },
          { x: minX + (maxX - minX) * 0.28, y: foreheadTop },
          { x: minX + (maxX - minX) * 0.08, y: browTop - jawHeight * 0.08 },
        ];

        setFaceFrame({
          confidence: result.detection.score,
          width: video.clientWidth,
          height: video.clientHeight,
          faceOutline: faceOutlinePoints.map((point) => `${point.x},${point.y}`).join(" "),
          meshLines: FACE_MESH_CONNECTIONS.map(([start, end]) => {
            const startPoint = landmarkPoints[start];
            const endPoint = landmarkPoints[end];
            return `${startPoint.x},${startPoint.y} ${endPoint.x},${endPoint.y}`;
          }),
          jaw: toPointString(result.landmarks.getJawOutline()),
          leftBrow: toPointString(result.landmarks.getLeftEyeBrow()),
          rightBrow: toPointString(result.landmarks.getRightEyeBrow()),
          noseBridge: toPointString(result.landmarks.getNose().slice(0, 4)),
          noseBase: toPointString(result.landmarks.getNose().slice(4)),
          leftEye: toPointString(result.landmarks.getLeftEye()),
          rightEye: toPointString(result.landmarks.getRightEye()),
          outerMouth: toPointString(result.landmarks.getMouth().slice(0, 12)),
          innerMouth: toPointString(result.landmarks.getMouth().slice(12)),
        });
      } catch {
        setFaceFrame(null);
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
      setMessage("Guided face capture complete. Review the details and register the employee.");
    } catch (error) {
      sequenceRef.current = false;
      setCountdown(null);
      setMessage(error instanceof Error ? error.message : "Face capture failed.");
    } finally {
      setBusy(false);
    }
  }

  function resetCapture() {
    sequenceRef.current = false;
    clearCountdownTimer();
    setDescriptors([]);
    setPreview("");
    setCaptureStepIndex(0);
    setCountdown(null);
    setFaceFrame(null);
    setBusy(false);
    setMessage(cameraActive ? "Capture reset. Begin the guided capture again." : "Start the camera for a guided face capture.");
  }

  function saveEnrollment() {
    if (!employeeId.trim() || !firstName.trim() || !lastName.trim() || !department.trim()) {
      setMessage("All employee details are required.");
      return;
    }
    if (!preview || descriptors.length < CAMERA_SAMPLE_TARGET) {
      setMessage("Capture all 3 face samples before registering.");
      return;
    }
    try {
      const enrollment: Enrollment = {
        id: crypto.randomUUID(),
        employeeId: employeeId.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        department: department.trim(),
        descriptors,
        referenceImage: preview,
        sampleCount: descriptors.length,
        createdAt: new Date().toISOString(),
      };
      const next = [enrollment, ...enrollments];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setEnrollments(next);
      setEmployeeId("");
      setFirstName("");
      setLastName("");
      setDepartment("");
      setDescriptors([]);
      setPreview("");
      setCaptureStepIndex(0);
      setCountdown(null);
      setFaceFrame(null);
      stopCamera();
      setMessage("Employee face registered successfully!");
    } catch {
      setMessage("Browser storage is full. Delete an older registration and try again.");
    }
  }

  function removeEnrollment(id: string) {
    if (!window.confirm("Delete this face registration?")) return;
    const next = enrollments.filter((item) => item.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setEnrollments(next);
  }

  return (
    <div className="face-page">
      <header className="face-page-heading">
        <div>
          <p className="eyebrow">Employee enrollment</p>
          <h2>Face Registration</h2>
          <p>Register employee face recognition profiles with mandatory employee details.</p>
        </div>
        <ScanFace size={38} />
      </header>

      <div className="face-workspace">
        <section className="face-card capture-card">
          <div className="capture-stage">
            {cameraActive ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : preview ? (
              <img src={preview} alt="Face enrollment preview" />
            ) : (
              <div className="capture-placeholder"><ScanFace size={72} /><span>No face captured</span></div>
            )}
            {cameraActive && faceFrame && (
              <svg
                className="face-tracker"
                viewBox={`0 0 ${faceFrame.width} ${faceFrame.height}`}
                aria-hidden="true"
              >
                <polygon className="face-outline" points={faceFrame.faceOutline} />
                {faceFrame.meshLines.map((points, index) => (
                  <polyline className="mesh-line" points={points} key={`${points}-${index}`} />
                ))}
                <polyline className="feature-line" points={faceFrame.jaw} />
                <polyline className="feature-line" points={faceFrame.leftBrow} />
                <polyline className="feature-line" points={faceFrame.rightBrow} />
                <polyline className="feature-line" points={faceFrame.noseBridge} />
                <polyline className="feature-line" points={faceFrame.noseBase} />
                <polygon className="feature-line" points={faceFrame.leftEye} />
                <polygon className="feature-line" points={faceFrame.rightEye} />
                <polygon className="feature-line" points={faceFrame.outerMouth} />
                <polygon className="feature-line" points={faceFrame.innerMouth} />
                <text x="14" y="24">{Math.round(faceFrame.confidence * 100)}%</text>
              </svg>
            )}
            {cameraActive && (
              <div className="capture-overlay">
                <span>{CAPTURE_STEPS[captureStepIndex].title}</span>
                <strong>{countdown ?? ""}</strong>
                <small>{CAPTURE_STEPS[captureStepIndex].helper}</small>
              </div>
            )}
          </div>

          <div className="pose-steps" aria-label="Face capture steps">
            {CAPTURE_STEPS.map((step, index) => {
              const complete = descriptors.length > index;
              const active = cameraActive && index === captureStepIndex && !complete;
              return (
                <div className={`pose-step ${complete ? "complete" : ""} ${active ? "active" : ""}`} key={step.key}>
                  {complete ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                  <span>{step.title}</span>
                </div>
              );
            })}
          </div>

          <div className="capture-actions">
            <button className="primary-button" onClick={cameraActive ? startGuidedCapture : startCamera} disabled={!modelsReady || busy}>
              <Camera size={17} /> {busy ? "Capturing automatically..." : cameraActive ? "Start guided capture" : "Start camera"}
            </button>
            <button className="outline-button" onClick={resetCapture} disabled={busy || (!cameraActive && descriptors.length === 0)}>
              <RotateCcw size={17} /> Reset
            </button>
          </div>

          <div className="sample-progress">{descriptors.length} / {CAMERA_SAMPLE_TARGET} guided samples captured</div>
          <p className="capture-message" role="status">{message}</p>
        </section>

        <section className="face-card enrollment-form">
          <h3>Employee Details</h3>
          
          <label htmlFor="employee-id">Employee ID *</label>
          <input
            id="employee-id"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            placeholder="e.g., EMP-001"
            maxLength={50}
          />

          <label htmlFor="first-name">First Name *</label>
          <input
            id="first-name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            placeholder="e.g., John"
            maxLength={100}
          />

          <label htmlFor="last-name">Last Name *</label>
          <input
            id="last-name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            placeholder="e.g., Doe"
            maxLength={100}
          />

          <label htmlFor="department">Department *</label>
          <input
            id="department"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            placeholder="e.g., Sales"
            maxLength={100}
          />

          <div className="enrollment-note">
            <strong>Important:</strong> Complete the front, left, and right guided captures in even lighting before registration.
          </div>
          <button className="primary-button save-face-button" onClick={saveEnrollment} disabled={busy || descriptors.length < CAMERA_SAMPLE_TARGET}>
            Register Employee Face
          </button>
        </section>
      </div>

      <section className="face-card enrollment-list">
        <div className="list-heading"><h3>Registered Employees</h3><span>{enrollments.length} total</span></div>
        {enrollments.length === 0 ? (
          <p className="empty-enrollments">No employees have been registered yet.</p>
        ) : (
          <div className="face-grid">
            {enrollments.map((item) => (
              <article className="face-item" key={item.id}>
                <img src={item.referenceImage} alt="" />
                <div>
                  <strong>{item.firstName} {item.lastName}</strong>
                  <span>{item.employeeId}</span>
                  <small>{item.department}</small>
                  <small>{new Date(item.createdAt).toLocaleString()}</small>
                </div>
                <button onClick={() => removeEnrollment(item.id)} aria-label={`Delete ${item.firstName} ${item.lastName}`}><Trash2 size={17} /></button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
