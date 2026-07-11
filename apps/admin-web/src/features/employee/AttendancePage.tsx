
import { CSSProperties, useCallback, useEffect, useState } from "react";
import {
  AlertCircle, CheckCircle, Clock, Coffee, LogIn, LogOut, MapPin,
} from "lucide-react";
import {
  TodayAttendance, WorkLocation, AttendanceSubmitResult, AttendanceEligibility,
  getTodayAttendance, submitAttendance, getMyWorkLocation, getMyWorkLocations,
  distanceInMeters, getFriendlyReason, getMyProfile,
} from "./api";
import CameraScanner, { GeoPoint } from "./components/CameraScanner";
import type { AuthUser } from "../../lib/api";
import "./AttendancePage.css";

type Props = { user: AuthUser };

type ResultState = {
  status: "approved" | "pending" | "rejected" | "error" | "info";
  title: string;
  message: string;
};

function fmtTime(v: string | null | undefined) {
  if (!v) return "--:--";
  return new Date(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function getEligibilityMessage(eligibility: AttendanceEligibility | null) {
  if (!eligibility) return "Checking your attendance eligibility...";
  if (!eligibility.faceEnrolled && !eligibility.hasWorkLocation) {
    return "Your face is not yet registered and you haven't been assigned a work location. Contact HR to get set up before recording attendance.";
  }
  if (!eligibility.faceEnrolled) {
    return "Your face is not yet registered for attendance verification. Contact HR to complete your face enrollment.";
  }
  if (!eligibility.hasWorkLocation) {
    return "You haven't been assigned a work location yet. Contact HR or your supervisor.";
  }
  return null;
}

export function AttendancePage({ user }: Props) {
  const [todayAtt,     setTodayAtt]     = useState<TodayAttendance | null>(null);
  const [eligibility,  setEligibility]  = useState<AttendanceEligibility | null>(null);
  const [isLoading,    setIsLoading]    = useState(true);
  // Scanner state
  const [scanType,      setScanType]      = useState<"TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN" | null>(null);
  const [isSubmitting,  setIsSubmitting]  = useState(false);
  const [resultModal,   setResultModal]   = useState<ResultState | null>(null);

  // FIELD site picker
  const [selectedSite,      setSelectedSite]      = useState<WorkLocation | null>(null);
  const [sitePickerSites,   setSitePickerSites]   = useState<WorkLocation[]>([]);
  const [sitePickerVisible, setSitePickerVisible] = useState(false);

  // Outside-work-area warning
  const [outsideWarning, setOutsideWarning] = useState<{
    type: "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";
    proceed: () => void;
  } | null>(null);

  const isField = user.attendanceMode === "FIELD";

  const loadToday = useCallback(async () => {
    if (!user.employeeId) return;
    try {
      const att = await getTodayAttendance(user.employeeId);
      setTodayAtt(att);
    } catch { /* non-blocking */ }
  }, [user.employeeId]);

  const loadEligibility = useCallback(async () => {
    if (!user.employeeId) return;
    try {
      const [profile, hasWorkLocation] = await Promise.all([
        getMyProfile(),
        isField
          ? getMyWorkLocations().then((sites) => sites.length > 0)
          : getMyWorkLocation().then((location) => location !== null),
      ]);
      setEligibility({ faceEnrolled: Boolean(profile.hasActiveFaceEnrollment), hasWorkLocation });
    } catch {
      setEligibility({ faceEnrolled: false, hasWorkLocation: false });
    }
  }, [isField, user.employeeId]);

  useEffect(() => {
    if (!user.employeeId) return;
    setIsLoading(true);
    Promise.all([loadToday(), loadEligibility()]).finally(() => setIsLoading(false));
  }, [loadEligibility, loadToday, user.employeeId]);

  const now = new Date();

  // Sunday is a company-wide rest day for every role — no attendance is
  // taken or required from anyone, mirrored from the same rule enforced
  // server-side in AttendanceService.submit().
  const isTodayDayOff = now.getDay() === 0;

  // ── Status logic ──────────────────────────────────────────────────────────
  const hasTimedIn   = Boolean(todayAtt?.timeInAt);
  const hasTimedOut  = Boolean(todayAtt?.timeOutAt);
  const hasOpenVisit = hasTimedIn && !hasTimedOut;

  const statusLabel = isTodayDayOff && !hasTimedIn
    ? "Day Off"
    : isField
      ? hasOpenVisit ? "Visit In Progress" : hasTimedIn ? "No Active Visit" : "Not Timed In"
      : hasTimedOut  ? "Day Completed"     : hasTimedIn ? "Timed In"        : "Not Timed In";

  const statusColor = isTodayDayOff && !hasTimedIn
    ? "#64748B"
    : isField
      ? hasOpenVisit ? "#1680D8" : hasTimedIn ? "#17A34A" : "#EF4444"
      : hasTimedOut  ? "#17A34A" : hasTimedIn ? "#1680D8" : "#EF4444";

  const isEligible = Boolean(eligibility?.faceEnrolled && eligibility?.hasWorkLocation);
  const eligibilityMessage = getEligibilityMessage(eligibility);
  const hasLunchOut = Boolean(todayAtt?.lunchOutAt);
  const hasLunchIn = Boolean(todayAtt?.lunchInAt);
  const showLunchSection = !isField && hasTimedIn;
  const lunchCompleted = hasLunchOut && hasLunchIn;

  const timeInDisabled  = isSubmitting || isLoading || isTodayDayOff || !isEligible || (isField ? hasOpenVisit : hasTimedIn);
  const timeOutDisabled = isField
    ? isSubmitting || isLoading || isTodayDayOff || !isEligible || !hasOpenVisit
    : isSubmitting || isLoading || isTodayDayOff || !isEligible || !hasTimedIn || hasTimedOut;
  const lunchButtonDisabled = isSubmitting || isLoading || isTodayDayOff || !isEligible || hasTimedOut || lunchCompleted;
  const lunchButtonLabel = lunchCompleted ? "LUNCH COMPLETED" : hasLunchOut ? "START LUNCH" : "END LUNCH";

  // ── Handlers ─────────────────────────────────────────────────────────────
  function ensureEligible() {
    if (isEligible) return true;
    setResultModal({
      status: "error",
      title: "Attendance Not Available",
      message: eligibilityMessage ?? "Attendance is not available yet. Contact HR or your supervisor.",
    });
    return false;
  }

  async function handleTimeIn() {
    if (!user.employeeId) return;
    if (!ensureEligible()) return;
    if (isField) { await startFieldTimeIn(); return; }
    const outside = await checkOutside();
    if (outside) {
      setOutsideWarning({ type: "TIME_IN", proceed: () => { setOutsideWarning(null); setScanType("TIME_IN"); } });
      return;
    }
    setScanType("TIME_IN");
  }

  async function handleTimeOut() {
    if (!ensureEligible()) return;
    if (isField) { setScanType("TIME_OUT"); return; }
    const outside = await checkOutside();
    if (outside) {
      setOutsideWarning({ type: "TIME_OUT", proceed: () => { setOutsideWarning(null); setScanType("TIME_OUT"); } });
      return;
    }
    setScanType("TIME_OUT");
  }

  async function handleLunch() {
    if (!ensureEligible()) return;
    if (!todayAtt?.timeInAt) {
      setResultModal({ status: "info", title: "Time In Required", message: "You need to time in before logging your lunch break." });
      return;
    }
    if (todayAtt.timeOutAt) {
      setResultModal({ status: "info", title: "Already Timed Out", message: "You've already timed out today." });
      return;
    }

    const next = hasLunchOut && !hasLunchIn ? "LUNCH_IN" : "LUNCH_OUT";
    if (next === "LUNCH_OUT" && hasLunchOut) {
      setResultModal({ status: "info", title: "Lunch Break Already Started", message: "You've already logged the start of your lunch break." });
      return;
    }
    if (next === "LUNCH_IN" && hasLunchIn) {
      setResultModal({ status: "info", title: "Lunch Break Already Ended", message: "You've already logged the end of your lunch break." });
      return;
    }

    const outside = await checkOutside();
    if (outside) {
      setOutsideWarning({ type: next, proceed: () => { setOutsideWarning(null); setScanType(next); } });
      return;
    }
    setScanType(next);
  }

  async function startFieldTimeIn() {
    try {
      const sites = await getMyWorkLocations();
      if (sites.length === 0) {
        setResultModal({ status: "error", title: "No Assigned Sites", message: "You don't have any assigned work sites yet. Contact your supervisor." });
        return;
      }
      if (sites.length === 1) { await handleSiteSelected(sites[0]); return; }
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 5000 }),
      );
      const nearest = sites.reduce(
        (closest, site) => {
          const distance = distanceInMeters(
            pos.coords.latitude,
            pos.coords.longitude,
            Number(site.latitude),
            Number(site.longitude),
          );
          return distance < closest.distance ? { site, distance } : closest;
        },
        { site: sites[0], distance: Infinity },
      );
      await handleSiteSelected(nearest.site);
    } catch (err) {
      setResultModal({ status: "error", title: "Failed to Detect Location", message: err instanceof Error ? err.message : "Please try again." });
    }
  }

  async function handleSiteSelected(site: WorkLocation) {
    setSitePickerVisible(false);
    setSelectedSite(site);
    const outside = await checkOutsideSite(site);
    if (outside) {
      setOutsideWarning({ type: "TIME_IN", proceed: () => { setOutsideWarning(null); setScanType("TIME_IN"); } });
      return;
    }
    setScanType("TIME_IN");
  }

  async function checkOutside(): Promise<boolean> {
    try {
      const [loc, pos] = await Promise.all([
        getMyWorkLocation(),
        new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 5000 }),
        ),
      ]);
      if (!loc) return false;
      return distanceInMeters(
        pos.coords.latitude, pos.coords.longitude,
        Number(loc.latitude), Number(loc.longitude),
      ) > Number(loc.radiusMeters);
    } catch { return false; }
  }

  async function checkOutsideSite(site: WorkLocation): Promise<boolean> {
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 5000 }),
      );
      return distanceInMeters(
        pos.coords.latitude, pos.coords.longitude,
        Number(site.latitude), Number(site.longitude),
      ) > Number(site.radiusMeters);
    } catch { return false; }
  }

  async function handleScanComplete(location: GeoPoint, faceBase64: string) {
    if (!scanType || !user.employeeId) return;
    const capturedScanType = scanType;
    setIsSubmitting(true);
    setScanType(null);

    try {
      const result: AttendanceSubmitResult = await submitAttendance({
        employeeId:      user.employeeId,
        latitude:        location.latitude,
        longitude:       location.longitude,
        accuracyMeters:  location.accuracy,
        livenessScore:   100,
        similarityScore: 100,
        faceImageBase64: faceBase64,
        deviceId:        "web-browser",
        workLocationId:  isField && capturedScanType === "TIME_IN" ? selectedSite?.id : undefined,
        action: capturedScanType !== "TIME_IN" ? capturedScanType : undefined,
      });

      const actionLabel =
        isField
          ? result.logType === "TIME_IN" ? "Visit Start" : "Visit End"
          : result.logType === "TIME_IN" ? "Time In"
            : result.logType === "TIME_OUT" ? "Time Out"
              : result.logType === "LUNCH_OUT" ? "Lunch Break Start"
                : "Lunch Break End";
      const ts  = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const msg = getFriendlyReason(
        result.faceResult.reason ?? result.geoResult.reason,
        result.verificationStatus,
      );

      if (result.verificationStatus === "APPROVED") {
        setResultModal({ status: "approved", title: `${actionLabel} Recorded`, message: `Verified at ${ts}. ${msg}` });
      } else if (result.verificationStatus === "PENDING_REVIEW") {
        setResultModal({ status: "pending", title: `${actionLabel} Pending Review`, message: msg });
      } else {
        setResultModal({ status: "rejected", title: `${actionLabel} Not Recorded`, message: msg });
      }

      await loadToday();
    } catch (err) {
      setResultModal({
        status: "error",
        title: "Submission Error",
        message: err instanceof Error ? err.message : "Failed to submit. Check your connection and try again.",
      });
    } finally {
      setIsSubmitting(false);
      setSelectedSite(null);
    }
  }

  const todayLabel = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  // ── Scanner overlay ───────────────────────────────────────────────────────
  if (scanType) {
    return (
      <CameraScanner
        logType={scanType}
        onComplete={handleScanComplete}
        onCancel={() => { setScanType(null); setSelectedSite(null); }}
      />
    );
  }

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <div className="emp-form-page">
        <div className="att-card" style={{ ...card, padding: 36 }}>
          <div className="att-header-row" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div className="att-header-text" style={{ minWidth: 0 }}>
              <p className="att-date" style={{ color: "#64748B", fontSize: 13, marginBottom: 6 }}>{todayLabel}</p>
              <h2 className="att-heading" style={{ color: "#062B59", fontSize: 20, fontWeight: 700, margin: 0 }}>
                Attendance Status
              </h2>
            </div>
            <div
              className="att-status-badge"
              style={{
                display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
                background: `${statusColor}1A`, border: `1px solid ${statusColor}`,
                borderRadius: 20, padding: "6px 10px",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
              <span style={{ color: statusColor, fontWeight: 700, fontSize: 12 }}>{statusLabel}</span>
            </div>
          </div>

          <p className="att-welcome" style={{ color: "#475569", fontSize: 14, marginTop: 16, marginBottom: 20 }}>
            Welcome back, {user.displayName}
          </p>

          <div className="att-stats-row" style={{ display: "flex", alignItems: "center", paddingTop: 18, borderTop: "1px solid #EDF1F6" }}>
            <div className="att-stat-col" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: 36, height: 36, borderRadius: 18, background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                <LogIn size={18} color="#1680D8" />
              </div>
              <p style={{ color: "#64748B", fontSize: 13, marginBottom: 4 }}>{isField ? "Visit Start" : "Time In"}</p>
              <p className="att-time-val" style={{ color: "#062B59", fontWeight: 700, fontSize: 16, margin: 0 }}>
                {fmtTime(todayAtt?.timeInAt)}
              </p>
            </div>

            <div className="att-stat-divider" style={{ width: 1, height: 52, background: "#E2E8F0", margin: "0 8px" }} />

            <div className="att-stat-col" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: 36, height: 36, borderRadius: 18, background: "#F0FDF4", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                <LogOut size={18} color="#17A34A" />
              </div>
              <p style={{ color: "#64748B", fontSize: 13, marginBottom: 4 }}>{isField ? "Visit End" : "Time Out"}</p>
              <p className="att-time-val" style={{ color: "#062B59", fontWeight: 700, fontSize: 16, margin: 0 }}>
                {fmtTime(todayAtt?.timeOutAt)}
              </p>
            </div>
          </div>

          {showLunchSection && (
            <div className="att-stats-row" style={{ display: "flex", alignItems: "center", paddingTop: 18, marginTop: 18, borderTop: "1px solid #EDF1F6" }}>
              <div className="att-stat-col" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 36, height: 36, borderRadius: 18, background: "#FFF7ED", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                  <Coffee size={18} color="#EA580C" />
                </div>
                <p style={{ color: "#64748B", fontSize: 13, marginBottom: 4 }}>Lunch Out</p>
                <p className="att-time-val" style={{ color: "#062B59", fontWeight: 700, fontSize: 16, margin: 0 }}>
                  {fmtTime(todayAtt?.lunchOutAt)}
                </p>
              </div>

              <div className="att-stat-divider" style={{ width: 1, height: 52, background: "#E2E8F0", margin: "0 8px" }} />

              <div className="att-stat-col" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 36, height: 36, borderRadius: 18, background: "#FFF7ED", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                  <Coffee size={18} color="#EA580C" />
                </div>
                <p style={{ color: "#64748B", fontSize: 13, marginBottom: 4 }}>Lunch In</p>
                <p className="att-time-val" style={{ color: "#062B59", fontWeight: 700, fontSize: 16, margin: 0 }}>
                  {fmtTime(todayAtt?.lunchInAt)}
                </p>
              </div>
            </div>
          )}
        </div>

        {isTodayDayOff && !hasTimedIn && (
          <div
            className="att-day-off"
            style={{
              display: "flex", alignItems: "center", gap: 10,
              background: "#F1F5F9", border: "1px solid #CBD5E1",
              borderRadius: 14, padding: 14, marginTop: 16,
            }}
          >
            <AlertCircle size={20} color="#64748B" />
            <span style={{ color: "#475569", fontSize: 13, lineHeight: 1.4 }}>
              Today is your day off (Sunday). Attendance is not required.
            </span>
          </div>
        )}

        <button
          disabled={timeInDisabled}
          onClick={handleTimeIn}
          className="att-btn"
          style={{
            ...btnBase,
            marginTop: 16,
            background: timeInDisabled ? "#94A3B8" : "#062B59",
            cursor:     timeInDisabled ? "not-allowed" : "pointer",
          }}
        >
          <LogIn size={18} color="#FFFFFF" />
          <span>{isSubmitting ? "Processing…" : isField ? "START VISIT" : "TIME IN"}</span>
        </button>

        <button
          disabled={timeOutDisabled}
          onClick={handleTimeOut}
          className="att-btn"
          style={{
            ...btnBase,
            marginTop: 10,
            background: timeOutDisabled ? "transparent" : "#062B59",
            border:     `1px solid ${timeOutDisabled ? "#CBD5E1" : "#062B59"}`,
            cursor:     timeOutDisabled ? "not-allowed" : "pointer",
          }}
        >
          <LogOut size={18} color={timeOutDisabled ? "#94A3B8" : "#FFFFFF"} />
          <span style={{ color: timeOutDisabled ? "#94A3B8" : "#FFFFFF" }}>
            {isField ? "END VISIT" : "TIME OUT"}
          </span>
        </button>

        {showLunchSection && (
          <button
            disabled={lunchButtonDisabled}
            onClick={handleLunch}
            className="att-btn"
            style={{
              ...btnBase,
              marginTop: 10,
              background: lunchButtonDisabled ? "#F8FAFC" : "#FFF7ED",
              border:     `1px solid ${lunchButtonDisabled ? "#CBD5E1" : "#EA580C"}`,
              cursor:     lunchButtonDisabled ? "not-allowed" : "pointer",
            }}
          >
            <Coffee size={18} color={lunchButtonDisabled ? "#94A3B8" : "#EA580C"} />
            <span style={{ color: lunchButtonDisabled ? "#94A3B8" : "#EA580C" }}>
              {isSubmitting ? "Processing..." : lunchButtonLabel}
            </span>
          </button>
        )}

        {eligibilityMessage ? (
          <div className="att-info" style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            background: "#FEF2F2", border: "1px solid #FECACA",
            borderRadius: 14, padding: "12px 14px", marginTop: 16,
          }}>
            <AlertCircle size={18} color="#DC2626" style={{ flexShrink: 0, marginTop: 1 }} />
            <p style={{ color: "#991B1B", fontSize: 13, margin: 0, lineHeight: "18px" }}>
              {eligibilityMessage}
            </p>
          </div>
        ) : (
          <div className="att-info" style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          background: "#EFF6FF", border: "1px solid #BFDBFE",
          borderRadius: 14, padding: "12px 14px", marginTop: 16,
        }}>
          <AlertCircle size={18} color="#1680D8" style={{ flexShrink: 0, marginTop: 1 }} />
          <p style={{ color: "#1E3A8A", fontSize: 13, margin: 0, lineHeight: "18px" }}>
            Please ensure your camera and location permissions are enabled before recording attendance.
          </p>
          </div>
        )}

      {/* ── Site picker modal (FIELD employees) ───────────────────────────── */}
      {sitePickerVisible && (
        <div style={overlayS}>
          <div style={modalCard}>
            <h3 style={{ color: "#062B59", fontSize: 16, fontWeight: 800, textAlign: "center", marginBottom: 6 }}>
              Select Site to Visit
            </h3>
            <p style={{ color: "#64748B", fontSize: 12, textAlign: "center", marginBottom: 14 }}>
              Choose which assigned site you're starting a visit at.
            </p>
            {sitePickerSites.map((site, i) => (
              <button
                key={site.id}
                onClick={() => handleSiteSelected(site)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "12px 0",
                  border: "none", borderTop: i > 0 ? "1px solid #edf3f8" : "none",
                  background: "none", cursor: "pointer", textAlign: "left",
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: "#EFF6FF",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <MapPin size={16} color="#1680D8" />
                </div>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "#334155" }}>{site.name}</span>
              </button>
            ))}
            <button
              onClick={() => setSitePickerVisible(false)}
              style={{ ...btnBase, background: "#F1F5F9", color: "#475569", marginTop: 12 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Outside-work-area warning ──────────────────────────────────────── */}
      {outsideWarning && (
        <div style={overlayS}>
          <div style={{ ...modalCard, textAlign: "center" }}>
            <AlertCircle size={32} color="#D97706" style={{ marginBottom: 12 }} />
            <h3 style={{ color: "#062B59", fontSize: 16, fontWeight: 800, marginBottom: 8 }}>
              Outside Work Area
            </h3>
            <p style={{ color: "#475569", fontSize: 13, marginBottom: 18, lineHeight: "18px" }}>
              You appear to be outside your designated work area. You can still continue,
              but your attendance may be flagged for review.
            </p>
            <button onClick={outsideWarning.proceed} style={{ ...btnBase, marginBottom: 10 }}>
              Continue Anyway
            </button>
            <button
              onClick={() => setOutsideWarning(null)}
              style={{ ...btnBase, background: "#F1F5F9", color: "#475569" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Result modal ───────────────────────────────────────────────────── */}
      {resultModal && (
        <div style={overlayS}>
          <div style={{ ...modalCard, textAlign: "center" }}>
            {resultModal.status === "approved" && (
              <div style={iconCircle("#ECFDF3")}>
                <CheckCircle size={48} color="#17A34A" />
              </div>
            )}
            {resultModal.status === "pending" && (
              <div style={iconCircle("#FFFBEB")}>
                <Clock size={48} color="#D97706" />
              </div>
            )}
            {(resultModal.status === "rejected" || resultModal.status === "error") && (
              <div style={iconCircle("#FEF2F2")}>
                <AlertCircle size={48} color="#DC2626" />
              </div>
            )}
            <h3 style={{ color: "#062B59", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              {resultModal.title}
            </h3>
            <p style={{ color: "#475569", fontSize: 14, lineHeight: "20px", marginBottom: 22 }}>
              {resultModal.message}
            </p>
            <button
              onClick={() => setResultModal(null)}
              style={{
                ...btnBase,
                background:
                  resultModal.status === "approved" ? "#17A34A"
                  : resultModal.status === "pending"  ? "#D97706"
                  : "#DC2626",
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared micro-styles ───────────────────────────────────────────────────────
const card: CSSProperties = {
  background: "#FFFFFF", borderRadius: 18, padding: 20,
  border: "1px solid #E2E8F0",
  boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
};
const btnBase: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
  width: "100%", height: 50, borderRadius: 14, border: "none",
  background: "#062B59", color: "#FFFFFF",
  fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1,
};
const overlayS: CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(6,43,89,0.55)",
  zIndex: 2000,
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: 24,
};
const modalCard: CSSProperties = {
  width: "100%", maxWidth: 400,
  background: "#fff", borderRadius: 20, padding: 20,
};

function iconCircle(bg: string): CSSProperties {
  return {
    width: 88, height: 88, borderRadius: "50%",
    background: bg,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 18px",
  };
}
