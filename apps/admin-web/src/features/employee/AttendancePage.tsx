
import { CSSProperties, useCallback, useEffect, useState } from "react";
import {
  AlertCircle, CalendarDays, CheckCircle, Clock, LogIn, LogOut, MapPin,
} from "lucide-react";
import {
  TodayAttendance, WorkLocation, AttendanceSubmitResult,
  LeaveBalance, AttendanceHistoryRecord,
  getTodayAttendance, submitAttendance, getMyWorkLocation, getMyWorkLocations,
  getAttendanceHistory, getLeaveBalances,
  distanceInMeters, getFriendlyReason,
} from "./api";
import CameraScanner, { GeoPoint } from "./components/CameraScanner";
import type { AuthUser } from "../../lib/api";
import "./AttendancePage.css";

type Props = { user: AuthUser };

type ResultState = {
  status: "approved" | "pending" | "rejected" | "error";
  title: string;
  message: string;
};

function fmtTime(v: string | null | undefined) {
  if (!v) return "--:--";
  return new Date(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function workdaysElapsed(year: number, month: number): number {
  const today = new Date().getDate();
  let count = 0;
  for (let d = 1; d <= today; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow > 0 && dow < 6) count++;
  }
  return count;
}

export function AttendancePage({ user }: Props) {
  const [todayAtt,     setTodayAtt]     = useState<TodayAttendance | null>(null);
  const [isLoading,    setIsLoading]    = useState(true);
  const [history,      setHistory]      = useState<AttendanceHistoryRecord[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([]);
  // Scanner state
  const [scanType,      setScanType]      = useState<"TIME_IN" | "TIME_OUT" | null>(null);
  const [isSubmitting,  setIsSubmitting]  = useState(false);
  const [resultModal,   setResultModal]   = useState<ResultState | null>(null);

  // FIELD site picker
  const [selectedSite,      setSelectedSite]      = useState<WorkLocation | null>(null);
  const [sitePickerSites,   setSitePickerSites]   = useState<WorkLocation[]>([]);
  const [sitePickerVisible, setSitePickerVisible] = useState(false);

  // Outside-work-area warning
  const [outsideWarning, setOutsideWarning] = useState<{
    type: "TIME_IN" | "TIME_OUT";
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

  useEffect(() => {
    if (!user.employeeId) return;
    setIsLoading(true);
    Promise.all([
      loadToday(),
      getAttendanceHistory(user.employeeId, 60).then(setHistory).catch(() => undefined),
      getLeaveBalances(user.employeeId).then(setLeaveBalances).catch(() => undefined),
    ]).finally(() => setIsLoading(false));
  }, [loadToday, user.employeeId]);

  // ── Monthly stats ─────────────────────────────────────────────────────────
  const now       = new Date();
  const curMonth  = now.getMonth();
  const curYear   = now.getFullYear();

  const monthlyRecs  = history.filter(r => {
    const d = new Date(r.attendanceDate);
    return d.getMonth() === curMonth && d.getFullYear() === curYear;
  });
  const daysPresent   = monthlyRecs.filter(r => r.timeInAt !== null).length;
  const lateArrivals  = monthlyRecs.filter(r => r.status === "LATE").length;
  const workdays      = workdaysElapsed(curYear, curMonth);
  const attendancePct = workdays > 0 ? Math.min(100, (daysPresent / workdays) * 100) : 0;

  // ── Status logic ──────────────────────────────────────────────────────────
  const hasTimedIn   = Boolean(todayAtt?.timeInAt);
  const hasTimedOut  = Boolean(todayAtt?.timeOutAt);
  const hasOpenVisit = hasTimedIn && !hasTimedOut;

  const statusLabel = isField
    ? hasOpenVisit ? "Visit In Progress" : hasTimedIn ? "No Active Visit" : "No Visit Started"
    : hasTimedOut  ? "Day Completed"     : hasTimedIn ? "Timed In"        : "Not Timed In";

  const statusColor = isField
    ? hasOpenVisit ? "#1680D8" : hasTimedIn ? "#17A34A" : "#EF4444"
    : hasTimedOut  ? "#17A34A" : hasTimedIn ? "#1680D8" : "#EF4444";

  const timeInDisabled  = isSubmitting || isLoading || (isField ? hasOpenVisit : hasTimedIn);
  const timeOutDisabled = isField
    ? isSubmitting || isLoading || !hasOpenVisit
    : isSubmitting || isLoading || !hasTimedIn || hasTimedOut;

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleTimeIn() {
    if (!user.employeeId) return;
    if (isField) { await startFieldTimeIn(); return; }
    const outside = await checkOutside();
    if (outside) {
      setOutsideWarning({ type: "TIME_IN", proceed: () => { setOutsideWarning(null); setScanType("TIME_IN"); } });
      return;
    }
    setScanType("TIME_IN");
  }

  async function handleTimeOut() {
    if (isField) { setScanType("TIME_OUT"); return; }
    const outside = await checkOutside();
    if (outside) {
      setOutsideWarning({ type: "TIME_OUT", proceed: () => { setOutsideWarning(null); setScanType("TIME_OUT"); } });
      return;
    }
    setScanType("TIME_OUT");
  }

  async function startFieldTimeIn() {
    try {
      const sites = await getMyWorkLocations();
      if (sites.length === 0) {
        setResultModal({ status: "error", title: "No Assigned Sites", message: "You don't have any assigned work sites yet. Contact your supervisor." });
        return;
      }
      if (sites.length === 1) { await handleSiteSelected(sites[0]); return; }
      setSitePickerSites(sites);
      setSitePickerVisible(true);
    } catch (err) {
      setResultModal({ status: "error", title: "Failed to Load Sites", message: err instanceof Error ? err.message : "Please try again." });
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
      });

      const actionLabel = isField
        ? result.logType === "TIME_IN" ? "Visit Start" : "Visit End"
        : result.logType === "TIME_IN" ? "Time In"    : "Time Out";
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
  const monthLabel = now.toLocaleString("en-US", { month: "long" });

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
    <div className="att-grid">

      {/* ── Left column: attendance card + action buttons ── */}
      <div>
        <div className="att-card" style={{ ...card, padding: 36 }}>
          <p className="att-date" style={{ color: "#64748B", fontSize: 13, marginBottom: 20 }}>{todayLabel}</p>
          <h2 className="att-heading" style={{ color: "#062B59", fontSize: 26, fontWeight: 800, marginBottom: 16 }}>
            Attendance Status
          </h2>
          <div className="att-status-row" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
            <span style={{ color: statusColor, fontWeight: 700, fontSize: 18 }}>{statusLabel}</span>
          </div>
          <p className="att-welcome" style={{ color: "#475569", fontSize: 14, marginBottom: 28 }}>
            Welcome back, {user.displayName}
          </p>

          {/* Hero time display */}
          <div className="att-time-hero" style={{
            display: "grid", gridTemplateColumns: "1fr 1fr",
            gap: 16, background: "#F8FAFC", borderRadius: 16,
            padding: "24px 28px", marginBottom: 4,
          }}>
            <div>
              <p style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>
                {isField ? "VISIT START" : "TIME IN"}
              </p>
              <p className="att-time-val" style={{ color: "#062B59", fontSize: 40, fontWeight: 800, lineHeight: 1, margin: 0 }}>
                {fmtTime(todayAtt?.timeInAt)}
              </p>
            </div>
            <div style={{ borderLeft: "1px solid #E2E8F0", paddingLeft: 16 }}>
              <p style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>
                {isField ? "VISIT END" : "TIME OUT"}
              </p>
              <p className="att-time-val" style={{ color: "#062B59", fontSize: 40, fontWeight: 800, lineHeight: 1, margin: 0 }}>
                {fmtTime(todayAtt?.timeOutAt)}
              </p>
            </div>
          </div>
        </div>

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
      </div>

      {/* ── Right column: monthly summary + leave balances ── */}
      <div className="att-right">

        {/* Monthly summary */}
        <div style={{ ...card, padding: "14px 16px" }}>
          <div style={{ ...sectionHead, marginBottom: 10 }}>
            <CalendarDays size={13} color="#062B59" />
            <span style={sectionTitle}>{monthLabel.toUpperCase()}</span>
          </div>

          {/* Attendance donut + stats side by side */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Donut: shows attendance rate */}
            <svg width="52" height="52" viewBox="0 0 52 52" style={{ flexShrink: 0 }}>
              <circle cx="26" cy="26" r="20" fill="none" stroke="#E2E8F0" strokeWidth="6" />
              <circle
                cx="26" cy="26" r="20" fill="none"
                stroke="#062B59" strokeWidth="6"
                strokeDasharray={`${attendancePct * 1.257} 125.7`}
                strokeLinecap="round"
                transform="rotate(-90 26 26)"
              />
              <text x="26" y="30" textAnchor="middle" fontSize="11" fontWeight="800" fill="#062B59">
                {Math.round(attendancePct)}%
              </text>
            </svg>

            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: "#062B59", lineHeight: 1 }}>{daysPresent}</span>
                <span style={{ fontSize: 11, color: "#64748B" }}>present</span>
              </div>
              {workdays > 0 && (
                <p style={{ fontSize: 10, color: "#94A3B8", margin: "2px 0 8px" }}>of {workdays} working days</p>
              )}
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontSize: 18, fontWeight: 800, lineHeight: 1, color: lateArrivals > 0 ? "#D97706" : "#17A34A" }}>
                  {lateArrivals}
                </span>
                <span style={{ fontSize: 11, color: "#64748B" }}>late</span>
              </div>
            </div>
          </div>
        </div>

        {/* Leave balances — donut with labels beside each slice */}
        {leaveBalances.length > 0 && (() => {
          const R = 30, CX = 120, CY = 82, SW = 10;
          const circ   = 2 * Math.PI * R;
          const LINE_R  = R + SW / 2 + 3;
          const LABEL_R = R + SW / 2 + 14;
          const totalRemaining = leaveBalances.reduce((s, l) => s + l.remainingDays, 0);
          const totalEarned    = leaveBalances.reduce((s, l) => s + l.earnedDays, 0);

          let cumPct = 0;
          const segs = leaveBalances.map((lb, i) => {
            const color     = LEAVE_COLORS[i % LEAVE_COLORS.length];
            const pct       = totalRemaining > 0 ? lb.remainingDays / totalRemaining : 0;
            const segLen    = pct * circ;
            const offset    = circ / 4 - cumPct * circ;
            const midDeg    = -90 + (cumPct + pct / 2) * 360;
            const midRad    = (midDeg * Math.PI) / 180;
            const lx        = CX + LABEL_R * Math.cos(midRad);
            const ly        = CY + LABEL_R * Math.sin(midRad);
            const lineX1    = CX + LINE_R * Math.cos(midRad);
            const lineY1    = CY + LINE_R * Math.sin(midRad);
            const lineX2    = CX + (LABEL_R - 5) * Math.cos(midRad);
            const lineY2    = CY + (LABEL_R - 5) * Math.sin(midRad);
            const anchor    = lx > CX + 6 ? "start" : lx < CX - 6 ? "end" : "middle";
            const shortName = lb.leaveTypeName.replace(/\s*leave$/i, "");
            cumPct += pct;
            return { lb, color, segLen, offset, lx, ly, lineX1, lineY1, lineX2, lineY2, anchor, shortName };
          });

          return (
            <div style={{ ...card, padding: "14px 16px" }}>
              <div style={{ ...sectionHead, marginBottom: 4 }}>
                <Clock size={13} color="#062B59" />
                <span style={sectionTitle}>LEAVE BALANCE</span>
                <span style={{ fontSize: 10, color: "#94A3B8", marginLeft: "auto" }}>{curYear}</span>
              </div>

              <svg viewBox="0 0 240 162" style={{ width: "100%", height: "auto", display: "block" }}>
                {/* Track */}
                <circle cx={CX} cy={CY} r={R} fill="none" stroke="#E2E8F0" strokeWidth={SW} />

                {/* Arc segments */}
                {totalRemaining > 0 && segs.map(({ lb, color, segLen, offset }) =>
                  lb.remainingDays > 0 && (
                    <circle
                      key={lb.leaveTypeId}
                      cx={CX} cy={CY} r={R} fill="none"
                      stroke={color} strokeWidth={SW}
                      strokeDasharray={`${segLen - 1.5} ${circ}`}
                      strokeDashoffset={offset}
                    />
                  )
                )}

                {/* Leader lines + labels beside each slice */}
                {segs.map(({ lb, color, lx, ly, lineX1, lineY1, lineX2, lineY2, anchor, shortName }) => (
                  <g key={lb.leaveTypeId}>
                    <line x1={lineX1} y1={lineY1} x2={lineX2} y2={lineY2}
                      stroke={color} strokeWidth="0.8" opacity="0.6" />
                    <text x={lx} y={ly - 2} textAnchor={anchor}
                      fontSize="9" fontWeight="600" fill="#334155">
                      {shortName}
                    </text>
                    <text x={lx} y={ly + 8} textAnchor={anchor}
                      fontSize="8.5" fontWeight="800" fill={color}>
                      {lb.remainingDays}/{lb.earnedDays}
                    </text>
                  </g>
                ))}

                {/* Center totals */}
                <text x={CX} y={CY + 4} textAnchor="middle" fontSize="14" fontWeight="800" fill="#062B59">
                  {totalRemaining}
                </text>
                <text x={CX} y={CY + 14} textAnchor="middle" fontSize="7" fill="#94A3B8">
                  of {totalEarned}
                </text>
              </svg>
            </div>
          );
        })()}
      </div>

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
const row: CSSProperties  = { display: "flex", justifyContent: "space-between", marginBottom: 12 };
const lbl: CSSProperties  = { color: "#64748B", fontSize: 14 };
const val: CSSProperties  = { color: "#062B59", fontWeight: 700, fontSize: 14 };
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

// Distinct colors for each leave type segment in the shared donut
const LEAVE_COLORS = [
  "#062B59", "#1680D8", "#EC4899", "#8B5CF6",
  "#EF4444", "#F59E0B", "#10B981", "#14B8A6", "#F97316",
];

// Right column stat styles
const sectionHead: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, marginBottom: 14,
};
const sectionTitle: CSSProperties = {
  fontSize: 11, fontWeight: 800, color: "#062B59", letterSpacing: 1,
};
const bigNum: CSSProperties = {
  fontSize: 36, fontWeight: 800, color: "#062B59", lineHeight: 1,
};
const statMeta: CSSProperties = {
  fontSize: 13, color: "#64748B",
};
const progressTrack: CSSProperties = {
  height: 7, background: "#E2E8F0", borderRadius: 4, overflow: "hidden",
};
const progressFill: CSSProperties = {
  height: "100%", borderRadius: 4, transition: "width 0.6s ease",
};
const progressCaption: CSSProperties = {
  fontSize: 11, color: "#94A3B8", marginTop: 5, marginBottom: 0,
};
const divider: CSSProperties = {
  borderTop: "1px solid #E2E8F0", margin: "14px 0",
};

function iconCircle(bg: string): CSSProperties {
  return {
    width: 88, height: 88, borderRadius: "50%",
    background: bg,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 18px",
  };
}
