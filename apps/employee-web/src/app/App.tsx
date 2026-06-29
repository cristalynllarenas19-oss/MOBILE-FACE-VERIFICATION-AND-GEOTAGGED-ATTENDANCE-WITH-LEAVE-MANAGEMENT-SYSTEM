import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Briefcase,
  CalendarDays,
  Camera,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  Home,
  Loader2,
  LogIn,
  LogOut,
  MapPin,
  Settings,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import logoUrl from "../assets/unileaf-logo.png";
import {
  AppNotification,
  AttendanceHistoryRecord,
  AttendanceLogPhoto,
  CreateLeaveRequestInput,
  EmployeeProfile,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  MobileUser,
  TodayAttendance,
  WorkLocation,
  changePassword,
  checkApiHealth,
  createLeaveRequest,
  detectFace,
  forgotPassword,
  getAttendanceHistory,
  getLeaveBalances,
  getLeaveRequests,
  getLeaveTypes,
  getMyProfile,
  getMyWorkLocation,
  getMyWorkLocations,
  getNotifications,
  getTodayAttendance,
  getUnreadNotificationCount,
  login,
  logout,
  markAllNotificationsRead,
  markNotificationRead,
  resetPassword,
  restoreSession,
  setInitialPassword,
  submitAttendance,
  verifyResetOtp,
} from "../lib/api";
import { getFriendlyReason } from "../utils/attendanceMessages";
import { distanceInMeters } from "../utils/geofence";

type Tab = "attendance" | "leave" | "dtr" | "workarea" | "settings";
type ResultStatus = "approved" | "pending" | "rejected" | "error" | "info";
type ResultState = { status: ResultStatus; title: string; message: string };
type BrowserLocation = { coords: { latitude: number; longitude: number; accuracy: number | null } };
type AuthView = "login" | "forgot-otp" | "forgot-new-password";

const NOTIFICATION_POLL_MS = 30000;

function alertMessage(title: string, message: string) {
  window.alert(`${title}\n\n${message}`);
}

function getCurrentPosition(): Promise<BrowserLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not available in this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          coords: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          },
        }),
      () => reject(new Error("Location permission is required to record attendance.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

function formatTime(value: string | null | undefined) {
  if (!value) return "--:--";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function toDataUri(log: AttendanceLogPhoto) {
  if (!log.faceImageData) return null;
  return `data:${log.faceImageMimeType ?? "image/jpeg"};base64,${log.faceImageData}`;
}

function readFileAsDataUri(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read selected file."));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<MobileUser | null>(null);
  const [todayAttendance, setTodayAttendance] = useState<TodayAttendance | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [scanType, setScanType] = useState<"TIME_IN" | "TIME_OUT" | null>(null);
  const [resultModal, setResultModal] = useState<ResultState | null>(null);
  const [selectedWorkLocation, setSelectedWorkLocation] = useState<WorkLocation | null>(null);
  const [sitePickerSites, setSitePickerSites] = useState<WorkLocation[]>([]);
  const [isSitePickerVisible, setIsSitePickerVisible] = useState(false);
  const [authView, setAuthView] = useState<AuthView>("login");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [hasSessionCheckFinished, setHasSessionCheckFinished] = useState(false);

  useEffect(() => {
    try {
      const restoredUser = restoreSession();
      if (restoredUser) setUser(restoredUser);
    } finally {
      setHasSessionCheckFinished(true);
    }
  }, []);

  useEffect(() => {
    if (user?.employeeId) refreshTodayAttendance(user.employeeId);
  }, [user?.employeeId]);

  async function refreshTodayAttendance(employeeId: string) {
    try {
      setTodayAttendance(await getTodayAttendance(employeeId));
    } catch (error) {
      console.error("Failed to load today's attendance", error);
    }
  }

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      alertMessage("Missing Information", "Please enter your email and password.");
      return;
    }
    setIsLoading(true);
    try {
      await checkApiHealth();
      setUser(await login(email, password));
    } catch (error) {
      alertMessage("Login Failed", error instanceof Error ? error.message : "Invalid email or password.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      alertMessage("Email Required", "Please enter your email address above first.");
      return;
    }
    setIsLoading(true);
    try {
      await forgotPassword(email.trim());
      setResetEmail(email.trim());
      setAuthView("forgot-otp");
    } catch (error) {
      alertMessage("Something Went Wrong", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleLogout() {
    logout();
    setUser(null);
    setTodayAttendance(null);
    setEmail("");
    setPassword("");
  }

  async function startScan(type: "TIME_IN" | "TIME_OUT") {
    if (!user?.employeeId) {
      setResultModal({
        status: "error",
        title: "Missing Employee Profile",
        message: "This account isn't linked to an employee record. Contact HR for assistance.",
      });
      return;
    }

    if (user.attendanceMode === "FIELD") {
      await startFieldScan(type);
      return;
    }

    if (type === "TIME_IN" && todayAttendance?.timeInAt) {
      setResultModal({ status: "info", title: "Already Timed In", message: "You've already timed in today. Tap Time Out when your shift ends." });
      return;
    }
    if (type === "TIME_OUT" && !todayAttendance?.timeInAt) {
      setResultModal({ status: "info", title: "Time In Required", message: "You need to time in before you can time out." });
      return;
    }
    if (type === "TIME_OUT" && todayAttendance?.timeOutAt) {
      setResultModal({ status: "info", title: "Already Timed Out", message: "You've already timed out today. See you next shift!" });
      return;
    }

    if (await checkOutsideWorkArea()) {
      if (!window.confirm("You appear to be outside your designated work area. Continue anyway?")) return;
    }
    setScanType(type);
  }

  async function startFieldScan(type: "TIME_IN" | "TIME_OUT") {
    if (type === "TIME_OUT") {
      setScanType("TIME_OUT");
      return;
    }
    try {
      const sites = await getMyWorkLocations();
      if (sites.length === 0) {
        setResultModal({ status: "error", title: "No Assigned Sites", message: "You don't have any assigned work sites yet. Contact your supervisor." });
        return;
      }
      if (sites.length === 1) {
        await handleSiteSelected(sites[0]);
        return;
      }
      setSitePickerSites(sites);
      setIsSitePickerVisible(true);
    } catch (error) {
      setResultModal({ status: "error", title: "Failed to Load Sites", message: error instanceof Error ? error.message : "Please try again." });
    }
  }

  async function handleSiteSelected(site: WorkLocation) {
    setIsSitePickerVisible(false);
    setSelectedWorkLocation(site);
    if (await checkOutsideSite(site)) {
      if (!window.confirm("You appear to be outside this site's geotagged area. Continue anyway?")) return;
    }
    setScanType("TIME_IN");
  }

  async function checkOutsideWorkArea() {
    try {
      const [workLocation, position] = await Promise.all([getMyWorkLocation(), getCurrentPosition()]);
      if (!workLocation) return false;
      return (
        distanceInMeters(
          position.coords.latitude,
          position.coords.longitude,
          Number(workLocation.latitude),
          Number(workLocation.longitude),
        ) > Number(workLocation.radiusMeters)
      );
    } catch (error) {
      console.error("Failed to check work area before scan", error);
      return false;
    }
  }

  async function checkOutsideSite(site: WorkLocation) {
    try {
      const position = await getCurrentPosition();
      return (
        distanceInMeters(position.coords.latitude, position.coords.longitude, Number(site.latitude), Number(site.longitude)) >
        Number(site.radiusMeters)
      );
    } catch (error) {
      console.error("Failed to check site area before scan", error);
      return false;
    }
  }

  async function handleScanComplete(location: BrowserLocation, faceBase64?: string) {
    if (!scanType || !user?.employeeId) return;
    setIsLoading(true);
    const currentScanType = scanType;
    setScanType(null);
    try {
      const result = await submitAttendance({
        employeeId: user.employeeId,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: location.coords.accuracy ?? 999,
        livenessScore: 100,
        similarityScore: 100,
        faceImageBase64: faceBase64 ?? "",
        deviceId: "browser-employee-web",
        workLocationId: user.attendanceMode === "FIELD" && currentScanType === "TIME_IN" ? selectedWorkLocation?.id : undefined,
      });

      const actionLabel =
        user.attendanceMode === "FIELD"
          ? result.logType === "TIME_IN"
            ? "Visit Start"
            : "Visit End"
          : result.logType === "TIME_IN"
            ? "Time In"
            : "Time Out";
      const friendlyMessage = getFriendlyReason(result.faceResult.reason ?? result.geoResult.reason, result.verificationStatus);
      const timestamp = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

      if (result.verificationStatus === "APPROVED") {
        setResultModal({ status: "approved", title: `${actionLabel} Recorded`, message: `Verified at ${timestamp}. Your Daily Time Record has been updated. ${friendlyMessage}` });
      } else if (result.verificationStatus === "PENDING_REVIEW") {
        setResultModal({ status: "pending", title: `${actionLabel} Pending Review`, message: friendlyMessage });
      } else {
        setResultModal({ status: "rejected", title: `${actionLabel} Not Recorded`, message: friendlyMessage });
      }
      await refreshTodayAttendance(user.employeeId);
    } catch (error) {
      setResultModal({ status: "error", title: "Submission Error", message: error instanceof Error ? error.message : "Failed to connect to the server. Check your connection and try again." });
    } finally {
      setIsLoading(false);
      setSelectedWorkLocation(null);
    }
  }

  function backToLogin() {
    setAuthView("login");
    setResetEmail("");
    setResetToken("");
  }

  if (!hasSessionCheckFinished) return <Splash />;
  if (!user && authView === "forgot-otp") {
    return <VerifyOtp email={resetEmail} onBack={backToLogin} onVerified={(token) => { setResetToken(token); setAuthView("forgot-new-password"); }} />;
  }
  if (!user && authView === "forgot-new-password") return <NewPassword resetToken={resetToken} onDone={backToLogin} />;
  if (!user) {
    return (
      <LoginScreen
        email={email}
        password={password}
        setEmail={setEmail}
        setPassword={setPassword}
        isLoading={isLoading}
        onLogin={handleLogin}
        onForgotPassword={handleForgotPassword}
      />
    );
  }
  if (scanType) {
    return (
      <CameraScanner
        logType={scanType}
        onComplete={handleScanComplete}
        onCancel={() => {
          setScanType(null);
          setSelectedWorkLocation(null);
        }}
      />
    );
  }

  return (
    <>
      <MainScreen
        user={user}
        isLoading={isLoading}
        todayAttendance={todayAttendance}
        onLogout={handleLogout}
        onTimeIn={() => startScan("TIME_IN")}
        onTimeOut={() => startScan("TIME_OUT")}
      />
      <SitePickerModal visible={isSitePickerVisible} sites={sitePickerSites} onSelect={handleSiteSelected} onCancel={() => setIsSitePickerVisible(false)} />
      <ResultModal result={resultModal} onClose={() => setResultModal(null)} />
    </>
  );
}

function Splash() {
  return (
    <main className="auth-page">
      <img src={logoUrl} className="splash-logo" alt="Unileaf" />
      <Loader2 className="spin" />
    </main>
  );
}

function LoginScreen(props: {
  email: string;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  isLoading: boolean;
  onLogin: () => void;
  onForgotPassword: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <img src={logoUrl} className="auth-logo" alt="Unileaf" />
        <h1>Log In</h1>
        <p>Attendance & Leave Management System</p>
        <label>Email Address</label>
        <div className="input-shell">
          <User size={18} />
          <input value={props.email} onChange={(event) => props.setEmail(event.target.value)} placeholder="Enter your email address" type="email" />
        </div>
        <label>Password</label>
        <div className="input-shell">
          <ShieldCheck size={18} />
          <input value={props.password} onChange={(event) => props.setPassword(event.target.value)} placeholder="Enter your password" type={showPassword ? "text" : "password"} />
          <button className="icon-button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        <button className="primary-button full" onClick={props.onLogin} disabled={props.isLoading}>
          {props.isLoading ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
          Log In
        </button>
        <button className="link-button" onClick={props.onForgotPassword}>Forgot Password?</button>
      </section>
    </main>
  );
}

function VerifyOtp({ email, onVerified, onBack }: { email: string; onVerified: (token: string) => void; onBack: () => void }) {
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit() {
    setLoading(true);
    try {
      const data = await verifyResetOtp(email, otp);
      onVerified(data.resetToken);
    } catch (error) {
      alertMessage("Invalid OTP", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <h1>Verify OTP</h1>
        <p>Enter the code sent to {email}.</p>
        <label>OTP</label>
        <div className="input-shell"><input value={otp} onChange={(event) => setOtp(event.target.value)} /></div>
        <button className="primary-button full" onClick={submit} disabled={loading}>{loading && <Loader2 className="spin" size={18} />} Verify</button>
        <button className="link-button" onClick={onBack}>Back to login</button>
      </section>
    </main>
  );
}

function NewPassword({ resetToken, onDone }: { resetToken: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit() {
    setLoading(true);
    try {
      await resetPassword(resetToken, password);
      alertMessage("Password Updated", "You can now sign in with your new password.");
      onDone();
    } catch (error) {
      alertMessage("Unable to Reset Password", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <h1>New Password</h1>
        <label>Password</label>
        <div className="input-shell"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
        <button className="primary-button full" onClick={submit} disabled={loading}>{loading && <Loader2 className="spin" size={18} />} Save Password</button>
      </section>
    </main>
  );
}

function MainScreen(props: {
  user: MobileUser;
  onLogout: () => void;
  onTimeIn: () => void;
  onTimeOut: () => void;
  isLoading: boolean;
  todayAttendance: TodayAttendance | null;
}) {
  const [tab, setTab] = useState<Tab>("attendance");
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsVisible, setNotificationsVisible] = useState(false);

  useEffect(() => {
    const refreshUnreadCount = () => getUnreadNotificationCount().then((data) => setUnreadCount(data.count)).catch(() => undefined);
    refreshUnreadCount();
    const interval = window.setInterval(refreshUnreadCount, NOTIFICATION_POLL_MS);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <main className="app-shell">
      <header className="top-header">
        <div className="brand"><img src={logoUrl} alt="Unileaf" /><div><strong>{props.user.displayName}</strong><span>{props.user.attendanceMode === "FIELD" ? "Field Employee" : "Employee"}</span></div></div>
        <button className="icon-button notification-button" onClick={() => setNotificationsVisible(true)} aria-label="Notifications">
          <Bell size={20} />{unreadCount > 0 && <span>{unreadCount}</span>}
        </button>
      </header>
      <NotificationsPanel visible={notificationsVisible} onClose={() => setNotificationsVisible(false)} onUnreadCountChange={setUnreadCount} />
      <section className="content-area">
        {tab === "attendance" && <AttendanceScreen {...props} />}
        {tab === "leave" && <LeaveScreen employeeId={props.user.employeeId} />}
        {tab === "dtr" && <DTRScreen employeeId={props.user.employeeId} />}
        {tab === "workarea" && <WorkAreaScreen attendanceMode={props.user.attendanceMode} />}
        {tab === "settings" && <SettingsScreen onLogout={props.onLogout} />}
      </section>
      <nav className="bottom-nav">
        {[
          ["attendance", Home, "Attendance"],
          ["leave", CalendarDays, "Leave"],
          ["dtr", FileText, "DTR"],
          ["workarea", MapPin, "Work Area"],
          ["settings", Settings, "Settings"],
        ].map(([id, Icon, label]) => (
          <button key={String(id)} className={tab === id ? "active" : ""} onClick={() => setTab(id as Tab)}>
            <Icon size={20} /><span>{String(label)}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

function AttendanceScreen({ user, isLoading, todayAttendance, onTimeIn, onTimeOut }: {
  user: MobileUser;
  isLoading: boolean;
  todayAttendance: TodayAttendance | null;
  onTimeIn: () => void;
  onTimeOut: () => void;
}) {
  const isField = user.attendanceMode === "FIELD";
  const hasTimedIn = Boolean(todayAttendance?.timeInAt);
  const hasTimedOut = Boolean(todayAttendance?.timeOutAt);
  const hasOpenVisit = hasTimedIn && !hasTimedOut;
  const statusLabel = isField ? (hasOpenVisit ? "Visit In Progress" : hasTimedIn ? "No Active Visit" : "No Visit Started") : hasTimedOut ? "Day Completed" : hasTimedIn ? "Timed In" : "Not Timed In";
  const statusTone = hasTimedOut || (isField && hasTimedIn && !hasOpenVisit) ? "success" : hasTimedIn ? "info" : "danger";
  const timeInDisabled = isLoading || (isField ? hasOpenVisit : hasTimedIn);
  const timeOutDisabled = isField ? isLoading || !hasOpenVisit : isLoading || !hasTimedIn || hasTimedOut;

  return (
    <div className="stack">
      <section className="panel">
        <p className="muted">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
        <h2>Attendance Status</h2>
        <div className={`status-line ${statusTone}`}><span />{statusLabel}</div>
        <p className="muted">Welcome back, {user.displayName}</p>
        <div className="time-row"><span>{isField ? "Visit Start" : "Time In"}</span><strong>{formatTime(todayAttendance?.timeInAt)}</strong></div>
        <div className="time-row"><span>{isField ? "Visit End" : "Time Out"}</span><strong>{formatTime(todayAttendance?.timeOutAt)}</strong></div>
      </section>
      <button className="primary-button full tall" disabled={timeInDisabled} onClick={onTimeIn}><LogIn size={20} />{isLoading ? "Loading..." : isField ? "START VISIT" : "TIME IN"}</button>
      <button className="primary-button full tall" disabled={timeOutDisabled} onClick={onTimeOut}><LogOut size={20} />{isField ? "END VISIT" : "TIME OUT"}</button>
      <section className="notice"><ShieldCheck size={22} />Please ensure your location and camera permissions are enabled before recording attendance.</section>
    </div>
  );
}

function CameraScanner({ logType, onComplete, onCancel }: {
  logType: "TIME_IN" | "TIME_OUT";
  onComplete: (location: BrowserLocation, faceBase64?: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("Starting camera...");
  const [loading, setLoading] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [progress, setProgress] = useState(0);
  const finishingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        setStream(mediaStream);
        if (videoRef.current) videoRef.current.srcObject = mediaStream;
        setStatus("Position your face inside the frame");
      })
      .catch(() => setStatus("Camera permission is required to use face verification attendance."));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!stream || loading) return;
    let cancelled = false;
    let timeout: number;
    async function poll() {
      try {
        const image = captureVideoFrame(videoRef.current, 0.55);
        if (image) {
          const result = await detectFace(image);
          if (!cancelled) {
            setFaceDetected(result.detected);
            setStatus(result.detected ? "Face detected, hold steady..." : "No face detected. Position your face inside the frame.");
          }
        }
      } catch {
        if (!cancelled) setFaceDetected(false);
      } finally {
        if (!cancelled) timeout = window.setTimeout(poll, 500);
      }
    }
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [stream, loading]);

  useEffect(() => {
    if (loading) return;
    const interval = window.setInterval(() => {
      setProgress((value) => {
        const next = faceDetected ? Math.min(100, value + 7) : 0;
        if (next >= 100 && !finishingRef.current) {
          finishingRef.current = true;
          finishScan();
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [faceDetected, loading]);

  async function finishScan() {
    setLoading(true);
    setStatus("Verifying Location & Identity...");
    try {
      const faceImage = captureVideoFrame(videoRef.current, 0.88);
      const location = await getCurrentPosition();
      stream?.getTracks().forEach((track) => track.stop());
      onComplete(location, faceImage ?? undefined);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to capture location or photo.");
      setLoading(false);
      finishingRef.current = false;
      setProgress(0);
    }
  }

  return (
    <main className="scanner-page">
      <header className="scanner-header"><button className="icon-button" onClick={onCancel}><X /></button><strong>{logType === "TIME_IN" ? "Time In" : "Time Out"} Verification</strong><span /></header>
      <section className="camera-stage">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className={`face-guide ${faceDetected ? "locked" : ""}`}>{progress >= 100 && <CheckCircle2 />}</div>
        <div className="scan-progress"><span style={{ width: `${progress}%` }} /></div>
      </section>
      <footer className="scanner-footer">{loading ? <Loader2 className="spin" /> : <Camera />}<span>{status}</span></footer>
    </main>
  );
}

function captureVideoFrame(video: HTMLVideoElement | null, quality: number) {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.translate(canvas.width, 0);
  context.scale(-1, 1);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function LeaveScreen({ employeeId }: { employeeId?: string }) {
  const [tab, setTab] = useState<"balance" | "request">("balance");
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [form, setForm] = useState({ leaveTypeId: "", startDate: "", endDate: "", reason: "", attachmentName: "", attachmentMimeType: "", attachmentData: "" });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!employeeId) return;
    const [leaveTypes, leaveBalances, leaveRequests] = await Promise.all([getLeaveTypes(), getLeaveBalances(employeeId), getLeaveRequests(employeeId)]);
    setTypes(leaveTypes);
    setBalances(leaveBalances);
    setRequests(leaveRequests);
    setForm((current) => ({ ...current, leaveTypeId: current.leaveTypeId || leaveTypes[0]?.id || "" }));
  }, [employeeId]);

  useEffect(() => {
    setLoading(true);
    load().catch((error) => alertMessage("Failed to Load Leave", error.message)).finally(() => setLoading(false));
  }, [load]);

  async function submitLeave() {
    if (!employeeId) return;
    const start = new Date(form.startDate);
    const end = new Date(form.endDate);
    const totalDays = Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
    const payload: CreateLeaveRequestInput = {
      employeeId,
      leaveTypeId: form.leaveTypeId,
      startDate: form.startDate,
      endDate: form.endDate,
      totalDays,
      reason: form.reason,
      attachmentName: form.attachmentName || undefined,
      attachmentMimeType: form.attachmentMimeType || undefined,
      attachmentData: form.attachmentData ? form.attachmentData.split(",")[1] : undefined,
    };
    try {
      await createLeaveRequest(payload);
      setForm((current) => ({ ...current, startDate: "", endDate: "", reason: "", attachmentName: "", attachmentMimeType: "", attachmentData: "" }));
      await load();
      alertMessage("Leave Submitted", "Your leave request has been submitted.");
    } catch (error) {
      alertMessage("Unable to Submit Leave", error instanceof Error ? error.message : "Please try again.");
    }
  }

  if (loading) return <LoadingBlock />;
  return (
    <div className="stack">
      <div className="segmented"><button className={tab === "balance" ? "active" : ""} onClick={() => setTab("balance")}>Balance</button><button className={tab === "request" ? "active" : ""} onClick={() => setTab("request")}>Request</button></div>
      {tab === "balance" ? (
        <div className="grid-list">
          {balances.map((balance) => <section className="panel compact" key={balance.leaveTypeId}><strong>{balance.leaveTypeName}</strong><div className="meter"><span style={{ width: `${Math.max(0, Math.min(100, (balance.remainingDays / Math.max(1, balance.earnedDays)) * 100))}%` }} /></div><p>{balance.remainingDays} of {balance.earnedDays} days remaining</p></section>)}
          <section className="panel"><h3>Requests</h3>{requests.map((request) => <div className="list-row" key={request.id}><div><strong>{request.leaveType.name}</strong><span>{formatDate(request.startDate)} - {formatDate(request.endDate)}</span></div><em>{request.status}</em></div>)}</section>
        </div>
      ) : (
        <section className="panel form-grid">
          <label>Leave Type<select value={form.leaveTypeId} onChange={(event) => setForm({ ...form, leaveTypeId: event.target.value })}>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
          <label>Start Date<input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} /></label>
          <label>End Date<input type="date" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} /></label>
          <label>Reason<textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
          <label>Attachment<input type="file" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setForm({ ...form, attachmentName: file.name, attachmentMimeType: file.type, attachmentData: await readFileAsDataUri(file) });
          }} /></label>
          <button className="primary-button" onClick={submitLeave}>Submit Request</button>
        </section>
      )}
    </div>
  );
}

function DTRScreen({ employeeId }: { employeeId?: string }) {
  const [records, setRecords] = useState<AttendanceHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"office" | "field">("office");
  const [filter, setFilter] = useState<"ALL" | "AM" | "PM">("ALL");
  const [selected, setSelected] = useState<AttendanceHistoryRecord | null>(null);

  const load = useCallback(async () => {
    if (!employeeId) return;
    setRecords(await getAttendanceHistory(employeeId));
  }, [employeeId]);

  useEffect(() => {
    setLoading(true);
    load().catch(() => undefined).finally(() => setLoading(false));
  }, [load]);

  const list = useMemo(() => {
    const scoped = records.filter((record) => (tab === "field" ? record.recordType === "FIELD" : record.recordType !== "FIELD"));
    if (tab !== "field" || filter === "ALL") return scoped;
    return scoped.filter((record) => (new Date(record.timeInAt ?? record.attendanceDate).getHours() < 12) === (filter === "AM"));
  }, [records, tab, filter]);

  if (loading) return <LoadingBlock />;
  return (
    <div className="stack">
      <div className="segmented"><button className={tab === "office" ? "active" : ""} onClick={() => setTab("office")}>Office</button><button className={tab === "field" ? "active" : ""} onClick={() => setTab("field")}>Field</button></div>
      {tab === "field" && <div className="segmented small">{["ALL", "AM", "PM"].map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item as "ALL" | "AM" | "PM")}>{item}</button>)}</div>}
      <section className="panel">
        {list.length === 0 ? <p className="empty">No records found.</p> : list.map((record) => (
          <button className="record-row" key={record.id} onClick={() => setSelected(record)}>
            <div><strong>{formatDate(record.attendanceDate)}{record.visitNumber ? ` #${record.visitNumber}` : ""}</strong><span>{record.workLocation?.name ?? (record.recordType === "FIELD" ? "Field Visit" : "Office")}</span></div>
            <div><span>{formatTime(record.timeInAt)} - {formatTime(record.timeOutAt)}</span><em>{record.status}</em></div>
          </button>
        ))}
      </section>
      {selected && <PhotoModal record={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PhotoModal({ record, onClose }: { record: AttendanceHistoryRecord; onClose: () => void }) {
  const photos = record.logs.filter((log) => log.logType === "TIME_IN" || log.logType === "TIME_OUT");
  return (
    <div className="modal-backdrop"><section className="modal wide"><button className="icon-button close" onClick={onClose}><X /></button><h2>Verification Photos</h2><div className="photo-grid">{photos.map((log) => <div key={log.id}>{toDataUri(log) ? <img src={toDataUri(log)!} alt={log.logType} /> : <div className="photo-empty">No photo</div>}<strong>{log.logType.replace("_", " ")}</strong><span>{formatTime(log.capturedAt)}</span></div>)}</div></section></div>
  );
}

function WorkAreaScreen({ attendanceMode }: { attendanceMode?: "FIXED" | "FIELD" }) {
  const isField = attendanceMode === "FIELD";
  const [locations, setLocations] = useState<WorkLocation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [position, setPosition] = useState<BrowserLocation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const sites = isField ? await getMyWorkLocations() : await getMyWorkLocation().then((site) => (site ? [site] : []));
      setLocations(sites);
      setSelectedId(sites[0]?.id ?? null);
      setPosition(await getCurrentPosition().catch(() => null));
    }
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [isField]);

  if (loading) return <LoadingBlock />;
  const selected = locations.find((location) => location.id === selectedId) ?? null;
  const distance = selected && position ? distanceInMeters(position.coords.latitude, position.coords.longitude, Number(selected.latitude), Number(selected.longitude)) : null;
  return (
    <div className="stack">
      {isField && <div className="chip-row">{locations.map((site) => <button key={site.id} className={site.id === selectedId ? "active" : ""} onClick={() => setSelectedId(site.id)}>{site.name}</button>)}</div>}
      {!selected ? <section className="panel empty">No geotagged work area has been assigned to you yet.</section> : (
        <>
          <section className="map-frame">
            <iframe title="Work area map" srcDoc={buildMapHtml(selected, position?.coords.latitude ?? null, position?.coords.longitude ?? null)} />
          </section>
          <section className="panel"><h2>{selected.name}</h2><p>Allowed radius: {selected.radiusMeters}m</p><p>Allowed accuracy: {selected.allowedAccuracyMeters}m</p>{distance != null && <div className={`status-line ${distance <= Number(selected.radiusMeters) ? "success" : "danger"}`}><span />{Math.round(distance)}m from work area</div>}</section>
        </>
      )}
    </div>
  );
}

function buildMapHtml(location: WorkLocation, userLat: number | null, userLon: number | null) {
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  const radius = Number(location.radiusMeters);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map').setView([${lat},${lon}],16);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap contributors'}).addTo(map);L.marker([${lat},${lon}]).addTo(map).bindPopup(${JSON.stringify(location.name)});L.circle([${lat},${lon}],{radius:${radius},color:'#1680D8',fillColor:'#1680D8',fillOpacity:.15}).addTo(map);${userLat !== null && userLon !== null ? `L.circleMarker([${userLat},${userLon}],{radius:8,color:'#DC2626',fillColor:'#DC2626',fillOpacity:.9}).addTo(map).bindPopup('You are here');map.fitBounds(L.latLngBounds([[${lat},${lon}],[${userLat},${userLon}]]),{padding:[40,40]});` : ""}</script></body></html>`;
}

function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  useEffect(() => { getMyProfile().then(setProfile).catch(() => undefined); }, []);
  async function savePassword() {
    try {
      if (currentPassword) await changePassword(currentPassword, newPassword);
      else await setInitialPassword(newPassword);
      setCurrentPassword("");
      setNewPassword("");
      alertMessage("Password Updated", "Your password has been changed.");
    } catch (error) {
      alertMessage("Unable to Update Password", error instanceof Error ? error.message : "Please try again.");
    }
  }
  return (
    <div className="stack">
      <section className="panel profile-panel"><div className="avatar">{profile?.profilePhotoData ? <img src={`data:${profile.profilePhotoMimeType ?? "image/jpeg"};base64,${profile.profilePhotoData}`} alt="" /> : <User />}</div><h2>{profile ? `${profile.firstName} ${profile.lastName}` : "Profile"}</h2><p>{profile?.user.email}</p><p>{profile?.department.name} · {profile?.position.title}</p></section>
      <section className="panel form-grid"><h2>Change Password</h2><label>Current Password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label>New Password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><button className="primary-button" onClick={savePassword}>Save Password</button></section>
      <button className="danger-button" onClick={onLogout}><LogOut size={18} />Log Out</button>
    </div>
  );
}

function NotificationsPanel({ visible, onClose, onUnreadCountChange }: { visible: boolean; onClose: () => void; onUnreadCountChange: (value: number) => void }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  useEffect(() => {
    if (!visible) return;
    getNotifications().then(setItems).catch(() => undefined);
  }, [visible]);
  if (!visible) return null;
  async function markRead(id: string) {
    await markNotificationRead(id);
    const next = items.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
    setItems(next);
    onUnreadCountChange(next.filter((item) => !item.readAt).length);
  }
  async function markAll() {
    await markAllNotificationsRead();
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    onUnreadCountChange(0);
  }
  return <div className="drawer"><button className="icon-button close" onClick={onClose}><X /></button><h2>Notifications</h2><button className="link-button" onClick={markAll}>Mark all as read</button>{items.map((item) => <button className={`notification-item ${item.readAt ? "" : "unread"}`} key={item.id} onClick={() => markRead(item.id)}><strong>{item.title}</strong><span>{item.message}</span></button>)}</div>;
}

function SitePickerModal({ visible, sites, onSelect, onCancel }: { visible: boolean; sites: WorkLocation[]; onSelect: (site: WorkLocation) => void; onCancel: () => void }) {
  if (!visible) return null;
  return <div className="modal-backdrop"><section className="modal"><button className="icon-button close" onClick={onCancel}><X /></button><h2>Select Work Site</h2>{sites.map((site) => <button className="list-row button-row" key={site.id} onClick={() => onSelect(site)}><Briefcase size={18} /><strong>{site.name}</strong></button>)}</section></div>;
}

function ResultModal({ result, onClose }: { result: ResultState | null; onClose: () => void }) {
  if (!result) return null;
  return <div className="modal-backdrop"><section className={`modal result ${result.status}`}><CheckCircle2 size={38} /><h2>{result.title}</h2><p>{result.message}</p><button className="primary-button" onClick={onClose}>OK</button></section></div>;
}

function LoadingBlock() {
  return <section className="panel loading"><Loader2 className="spin" />Loading...</section>;
}
