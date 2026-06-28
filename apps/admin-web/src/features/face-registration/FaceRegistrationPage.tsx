import * as faceapi from "face-api.js";
import { Camera, CheckCircle2, Eye, Pencil, RotateCcw, ScanFace, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../../lib/api";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
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

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  department?: { name: string } | null;
};

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

export function FaceRegistrationPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRef = useRef(false);
  const countdownTimerRef = useRef<number | null>(null);
  const faceTrackingTimerRef = useRef<number | null>(null);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [descriptors, setDescriptors] = useState<number[][]>([]);
  const [preview, setPreview] = useState("");
  const [enrollments, setEnrollments] = useState<FaceProfile[]>([]);
  const [message, setMessage] = useState("Loading face recognition models...");
  const [busy, setBusy] = useState(false);
  const [captureStepIndex, setCaptureStepIndex] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [faceFrame, setFaceFrame] = useState<FaceFrame | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [lastRegisteredEmployee, setLastRegisteredEmployee] = useState<Employee | null>(null);
  const [lastActionWasEdit, setLastActionWasEdit] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState<string>("ALL");
  const [listDepartmentFilter, setListDepartmentFilter] = useState<string>("ALL");
  const [viewProfile, setViewProfile] = useState<FaceProfile | null>(null);
  const [editingEnrollmentId, setEditingEnrollmentId] = useState<string | null>(null);
  const captureCardRef = useRef<HTMLDivElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<FaceProfile | null>(null);

  useEffect(() => {
    Promise.all([
      apiRequest<Employee[]>("/employees"),
      apiRequest<FaceProfile[]>("/face-profiles"),
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
      .then(([employeeData, faceProfiles]) => {
        setEmployees(employeeData);
        setEnrollments(faceProfiles);
        setModelsReady(true);
        setMessage("");
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
    if (!selectedEmployee) {
      setMessage("Search and select an employee first.");
      return;
    }
    if (!preview || descriptors.length < CAMERA_SAMPLE_TARGET) {
      setMessage("Capture the face sample before registering.");
      return;
    }
    try {
      const employeeToRegister = selectedEmployee;
      const enrollmentIdBeingEdited = editingEnrollmentId;
      if (enrollmentIdBeingEdited) {
        apiRequest<FaceProfile>(`/face-profiles/${enrollmentIdBeingEdited}`, {
          method: "PATCH",
          body: JSON.stringify({ referenceImageData: preview, descriptors }),
        }).then((updated) => {
          setEnrollments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
          setLastRegisteredEmployee(employeeToRegister);
          setLastActionWasEdit(true);
          setShowSuccessModal(true);
        });
      } else {
        apiRequest<FaceProfile>("/face-profiles", {
          method: "POST",
          body: JSON.stringify({
            employeeId: selectedEmployee.id,
            referenceImageData: preview,
            descriptors,
          }),
        }).then((enrollment) => {
          setEnrollments((current) => [enrollment, ...current]);
          setLastRegisteredEmployee(employeeToRegister);
          setLastActionWasEdit(false);
          setShowSuccessModal(true);
        });
      }
      setEditingEnrollmentId(null);
      setEmployeeSearch("");
      setSelectedEmployee(null);
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

  function removeEnrollment(id: string) {
    apiRequest(`/face-profiles/${id}`, { method: "DELETE" }).then(() => {
      setEnrollments((current) => current.filter((item) => item.id !== id));
      setDeleteTarget(null);
    });
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
    setEmployeeSearch(`${employeeLabel(profile.employee)} · ${profile.employee.employeeNo}`);
    setMessage(`Editing face photo for ${employeeLabel(profile.employee)}. Starting camera...`);
    captureCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    startCamera();
  }

  const departmentOptions = Array.from(
    new Set(employees.map((e) => e.department?.name).filter((name): name is string => Boolean(name))),
  ).sort((a, b) => a.localeCompare(b));

  const visibleEmployees = employees
    .filter((employee) => {
      const query = employeeSearch.trim().toLowerCase();
      if (!query) return true;
      return (
        employee.employeeNo.toLowerCase().includes(query) ||
        employeeLabel(employee).toLowerCase().includes(query) ||
        employee.department?.name?.toLowerCase().includes(query)
      );
    })
    .filter((employee) => departmentFilter === "ALL" || employee.department?.name === departmentFilter)
    .slice(0, 8);

  const enrollmentDepartmentOptions = Array.from(
    new Set(enrollments.map((item) => item.employee.department?.name).filter((name): name is string => Boolean(name))),
  ).sort((a, b) => a.localeCompare(b));

  const visibleEnrollments = enrollments.filter(
    (item) => listDepartmentFilter === "ALL" || item.employee.department?.name === listDepartmentFilter,
  );

  return (
    <div className="face-page">
      <div className="face-workspace">
        <section className="face-card capture-card" ref={captureCardRef}>
          <div className="capture-summary">
            <div>
              <p>{editingEnrollmentId ? "Editing photo for" : "Selected employee"}</p>
              <strong>{selectedEmployee ? `${employeeLabel(selectedEmployee)} · ${selectedEmployee.employeeNo}` : "None selected"}</strong>
            </div>
            <div>
              <p>Status</p>
              <strong>{selectedEmployee ? "Ready for capture" : "Choose an employee first"}</strong>
            </div>
            <div className="stat-inline-card">
              <span className="stat-value">{enrollments.length}</span>
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
            <button className="primary-button" onClick={cameraActive ? startGuidedCapture : startCamera} disabled={!modelsReady || busy}>
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
              <p className="form-kicker">{editingEnrollmentId ? "Editing" : "Step 1"}</p>
              <h3>{editingEnrollmentId ? "Update Face Photo" : "Select Employee"}</h3>
            </div>
            {!editingEnrollmentId && (
              <DropdownFilter
                value={departmentFilter}
                onChange={setDepartmentFilter}
                options={departmentOptions.map((name) => ({ value: name, label: name }))}
                allLabel="All Departments"
                menuLabel="Filter by department"
                ariaLabel="Department"
              />
            )}
          </div>

          {editingEnrollmentId ? (
            <p className="capture-message">Capture a new photo below for this employee, then save to replace their existing photo.</p>
          ) : (
            <>
              <label htmlFor="employee-search">Search by name or employee ID</label>
              <div className="search-shell">
                <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  id="employee-search"
                  value={employeeSearch}
                  onChange={(event) => setEmployeeSearch(event.target.value)}
                  placeholder="Type an employee name or ID"
                  maxLength={80}
                  autoComplete="off"
                />
              </div>

              <div className="employee-picks">
                {visibleEmployees.map((employee) => {
                  const active = selectedEmployee?.id === employee.id;
                  return (
                    <button
                      key={employee.id}
                      type="button"
                      className={`employee-pick ${active ? "active" : ""}`}
                      onClick={() => {
                        setSelectedEmployee(employee);
                        setEmployeeSearch(`${employeeLabel(employee)} · ${employee.employeeNo}`);
                      }}
                    >
                      <strong>{employeeLabel(employee)}</strong>
                      <span>{employee.employeeNo}</span>
                      <small>{employee.department?.name ?? "No department"}</small>
                    </button>
                  );
                })}
                {visibleEmployees.length === 0 && (
                  <p className="no-employee-matches">No employees match this search or filter.</p>
                )}
              </div>
            </>
          )}

          {selectedEmployee && (
            <div className="selected-employee-card">
              <div>
                <p>{editingEnrollmentId ? "Editing photo for" : "Selected employee"}</p>
                <strong>{employeeLabel(selectedEmployee)}</strong>
                <span>{selectedEmployee.employeeNo}</span>
              </div>
              <div>
                <p>Department</p>
                <strong>{selectedEmployee.department?.name ?? "Unknown"}</strong>
              </div>
            </div>
          )}

          <div className="form-actions">
            <button
              className="primary-button save-face-button"
              onClick={saveEnrollment}
              disabled={busy || descriptors.length < CAMERA_SAMPLE_TARGET || !selectedEmployee}
            >
              {editingEnrollmentId ? "Save New Photo" : "Register Employee Face"}
            </button>
            <button
              className="outline-button cancel-button"
              onClick={() => { setEditingEnrollmentId(null); setSelectedEmployee(null); setEmployeeSearch(""); resetCapture(); stopCamera(); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </section>
      </div>

      <section className="face-card enrollment-list">
        <div className="list-heading">
          <h3>Registered Employees</h3>
          <div className="list-heading-right">
            <DropdownFilter
              value={listDepartmentFilter}
              onChange={setListDepartmentFilter}
              options={enrollmentDepartmentOptions.map((name) => ({ value: name, label: name }))}
              allLabel="All Departments"
              menuLabel="Filter by department"
              ariaLabel="Department"
            />
            <span>{visibleEnrollments.length} total</span>
          </div>
        </div>

        {enrollments.length === 0 ? (
          <p className="empty-enrollments">No employees have been registered yet.</p>
        ) : visibleEnrollments.length === 0 ? (
          <p className="empty-enrollments">No registered employees match this department filter.</p>
        ) : (
          <div className="face-grid">
            {visibleEnrollments.map((item) => (
              <article
                className="face-item"
                key={item.id}
                onClick={() => openViewModal(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") openViewModal(item);
                }}
              >
                <img src={item.referenceImageData ?? ""} alt="" />
                <div>
                  <strong>{employeeLabel(item.employee)}</strong>
                  <span>{item.employee.employeeNo}</span>
                  <small>{item.employee.department?.name ?? "Unknown department"}</small>
                  <small>{item.enrolledAt ? new Date(item.enrolledAt).toLocaleString() : "Pending"}</small>
                </div>
                <div className="face-item-actions">
                  <button
                    className="face-item-view"
                    onClick={(event) => { event.stopPropagation(); openViewModal(item); }}
                    aria-label={`View ${employeeLabel(item.employee)}`}
                  >
                    <Eye size={16} />
                  </button>
                  <button
                    onClick={(event) => { event.stopPropagation(); setDeleteTarget(item); }}
                    aria-label={`Delete ${employeeLabel(item.employee)}`}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {viewProfile && (
        <div className="view-modal-overlay" onClick={closeViewModal}>
          <div className="view-modal" onClick={(event) => event.stopPropagation()}>
            <button className="view-modal-close" onClick={closeViewModal} aria-label="Close">
              <X size={18} />
            </button>
            <div className="view-modal-photo">
              <img src={viewProfile.referenceImageData ?? ""} alt="" />
            </div>
            <h3>{employeeLabel(viewProfile.employee)}</h3>
            <p className="view-modal-sub">{viewProfile.employee.employeeNo} · {viewProfile.employee.department?.name ?? "No department"}</p>
            <dl className="view-modal-details">
              <div>
                <dt>Status</dt>
                <dd>{viewProfile.enrollmentStatus}</dd>
              </div>
              <div>
                <dt>Enrolled</dt>
                <dd>{viewProfile.enrolledAt ? new Date(viewProfile.enrolledAt).toLocaleString() : "Pending"}</dd>
              </div>
            </dl>
            <div className="view-modal-actions">
              <button className="primary-button" onClick={() => editProfilePhoto(viewProfile)}>
                <Pencil size={16} /> Re-register Face
              </button>
              <button className="outline-button" onClick={closeViewModal}>Close</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="delete-modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="delete-modal-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path
                  d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                  fill="#fee2e2" stroke="#ef4444" strokeWidth="1.5" strokeLinejoin="round"
                />
                <line x1="12" y1="9" x2="12" y2="13" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="12" cy="17" r="0.8" fill="#ef4444" />
              </svg>
            </div>
            <h3>Delete Face Registration</h3>
            <p className="delete-modal-message">
              Are you sure you want to delete the face profile for{" "}
              <strong>{employeeLabel(deleteTarget.employee)}</strong>?
              <br />
              <span className="delete-modal-id">
                {deleteTarget.employee.employeeNo} · {deleteTarget.employee.department?.name ?? "No department"}
              </span>
            </p>
            <div className="delete-modal-actions">
              <button className="danger-button" onClick={() => removeEnrollment(deleteTarget.id)}>Delete</button>
              <button className="outline-button" onClick={() => setDeleteTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}