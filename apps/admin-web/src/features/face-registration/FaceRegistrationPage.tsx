import * as faceapi from "face-api.js";
import { Camera, ScanFace, Trash2 } from "lucide-react";
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

const MODEL_URL = "/models";
const CAMERA_SAMPLE_TARGET = 3;
const STORAGE_KEY = "employeeFaceEnrollments";

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

  useEffect(() => {
    Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
      .then(() => {
        setModelsReady(true);
        setMessage("Models ready. Start the camera and capture 3 clear samples.");
      })
      .catch(() => setMessage("Face models could not be loaded. Refresh the page and try again."));

    return stopCamera;
  }, []);

  useEffect(() => {
    if (cameraActive && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraActive]);

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
      setMethod("CAMERA");
      setDescriptors([]);
      setPreview("");
      setMessage(`Capture ${CAMERA_SAMPLE_TARGET} clear samples for a stronger enrollment.`);
    } catch {
      setMessage("Camera access was denied or no camera is available. Use image upload instead.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
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

  async function captureSample() {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || busy) return;
    setBusy(true);
    try {
      const descriptor = await detectFace(video);
      const image = imageFromVideo(video);
      setDescriptors((current) => [...current.slice(0, CAMERA_SAMPLE_TARGET - 1), descriptor]);
      setPreview(image);
      setMessage(`Sample ${Math.min(descriptors.length + 1, CAMERA_SAMPLE_TARGET)} of ${CAMERA_SAMPLE_TARGET} captured.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Face capture failed.");
    } finally {
      setBusy(false);
    }
  }

  function saveEnrollment() {
    if (!employeeId.trim() || !firstName.trim() || !lastName.trim() || !department.trim()) {
      setMessage("All employee details are required.");
      return;
    }
    if (!preview || descriptors.length === 0) {
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
            <div className="face-guide" aria-hidden="true" />
          </div>

          <div className="capture-actions">
            <button className="primary-button" onClick={cameraActive ? captureSample : startCamera} disabled={!modelsReady || busy}>
              <Camera size={17} /> {cameraActive ? "Capture sample" : "Start camera"}
            </button>
          </div>

          {cameraActive && <div className="sample-progress">{descriptors.length} / {CAMERA_SAMPLE_TARGET} camera samples</div>}
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
            <strong>Important:</strong> Capture all 3 samples in even lighting for best results. Position face directly in front of camera.
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
