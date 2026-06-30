/**
 * DtrPage — employee self-service Daily Time Record
 *
 * Mirrors employee-mobile DTRScreen exactly:
 *  • Office / Field tab switcher
 *  • Summary card: today's hours rendered (latest visit for Field)
 *  • AM / PM filter chips (Field tab only)
 *  • List of attendance records: date, site name (Field), status badge,
 *    time in → time out, hours rendered
 *  • Tap a row → modal with Time-In / Time-Out photo sub-tabs
 *
 * Endpoint: GET /attendance/history/:employeeId?limit=30
 */

import { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Camera } from "lucide-react";
import { AttendanceHistoryRecord, AttendanceLogPhoto, getAttendanceHistory } from "./api";
import type { AuthUser } from "../../lib/api";

type Props = { user: AuthUser };
type Tab   = "office" | "field";
type AmPm  = "ALL" | "AM" | "PM";

// ── Helpers ───────────────────────────────────────────────────────────────────
function isMorning(v: string | null) {
  if (!v) return true;
  return new Date(v).getHours() < 12;
}
function fmtDate(v: string) {
  return new Date(v).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(v: string | null) {
  if (!v) return "--:--";
  return new Date(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtLogTime(v: string) {
  return new Date(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function fmtHours(mins: number) {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function photoUri(log: AttendanceLogPhoto) {
  if (!log.faceImageData) return null;
  return `data:${log.faceImageMimeType ?? "image/jpeg"};base64,${log.faceImageData}`;
}
function statusTone(s: string): { color: string; bg: string; icon: string } {
  if (s === "PRESENT")           return { color: "#17A34A", bg: "#ECFDF3", icon: "✓" };
  if (s === "LATE")              return { color: "#D97706", bg: "#FFFBEB", icon: "⚠" };
  if (s === "ON_LEAVE")          return { color: "#1680D8", bg: "#EFF6FF", icon: "📅" };
  if (s === "OFFICIAL_BUSINESS") return { color: "#7C3AED", bg: "#F5F3FF", icon: "💼" };
  if (s === "ABSENT")            return { color: "#DC2626", bg: "#FEF2F2", icon: "✕" };
  return { color: "#94A3B8", bg: "#F8FAFC", icon: "⏱" };
}
function latestOfToday(recs: AttendanceHistoryRecord[]) {
  const key    = new Date().toDateString();
  const todays = recs.filter((r) => new Date(r.attendanceDate).toDateString() === key);
  if (!todays.length) return null;
  return todays.reduce((best, r) => ((r.visitNumber ?? 1) > (best.visitNumber ?? 1) ? r : best));
}

export function DtrPage({ user }: Props) {
  const [records,     setRecords]     = useState<AttendanceHistoryRecord[]>([]);
  const [isLoading,   setIsLoading]   = useState(true);
  const [isRefresh,   setIsRefresh]   = useState(false);
  const [activeTab,   setActiveTab]   = useState<Tab>("office");
  const [amPm,        setAmPm]        = useState<AmPm>("ALL");
  const [selected,    setSelected]    = useState<AttendanceHistoryRecord | null>(null);
  const [photoTab,    setPhotoTab]    = useState<"TIME_IN" | "TIME_OUT">("TIME_IN");

  const load = useCallback(async () => {
    if (!user.employeeId) return;
    try {
      const data = await getAttendanceHistory(user.employeeId);
      setRecords(data);
    } catch { /* non-blocking */ }
  }, [user.employeeId]);

  useEffect(() => {
    setIsLoading(true);
    load().finally(() => setIsLoading(false));
  }, [load]);

  async function handleRefresh() {
    setIsRefresh(true);
    await load();
    setIsRefresh(false);
  }

  const officeRecs = useMemo(() => records.filter((r) => r.recordType !== "FIELD"), [records]);
  const fieldRecs  = useMemo(() => records.filter((r) => r.recordType === "FIELD"),  [records]);
  const filteredField = useMemo(() => {
    if (amPm === "ALL") return fieldRecs;
    return fieldRecs.filter((r) => isMorning(r.timeInAt) === (amPm === "AM"));
  }, [fieldRecs, amPm]);

  const isOffice     = activeTab === "office";
  const listData     = isOffice ? officeRecs : filteredField;
  const todayRecord  = isOffice ? latestOfToday(officeRecs) : latestOfToday(fieldRecs);
  const todayInProg  = Boolean(todayRecord?.timeInAt) && !todayRecord?.timeOutAt;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>

      <h2 style={{ color: "#062B59", fontSize: 18, fontWeight: 900, marginBottom: 16 }}>
        Daily Time Record
      </h2>

      {/* Tab switcher */}
      <div style={tabSwitcher}>
        {(["office", "field"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              ...tabBtn,
              background: activeTab === t ? "#062B59" : "transparent",
              color:      activeTab === t ? "#FFFFFF"  : "#64748B",
            }}
          >
            {t === "office" ? "Office" : "Field"}
          </button>
        ))}
      </div>

      {/* Summary card */}
      <div style={summaryCard}>
        <span style={{ fontSize: 18, color: "#1680D8" }}>⏱</span>
        <div style={{ flex: 1 }}>
          <p style={{ color: "#1E3A8A", fontSize: 12, fontWeight: 600, margin: 0 }}>
            {isOffice ? "Today's Hours Rendered" : "Today's Hours Rendered (Latest Visit)"}
          </p>
          <p style={{ color: "#062B59", fontSize: 20, fontWeight: 800, margin: "2px 0 0" }}>
            {todayRecord
              ? fmtHours(todayRecord.totalMinutes) ?? (todayInProg ? "In progress" : "--")
              : isOffice ? "Not yet timed in" : "No visit started"}
          </p>
        </div>
        <button onClick={handleRefresh} disabled={isRefresh} style={refreshBtn}>
          {isRefresh ? "…" : "↻"}
        </button>
      </div>

      {/* AM/PM filter (Field only) */}
      {!isOffice && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {(["ALL", "AM", "PM"] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setAmPm(opt)}
              style={{
                ...filterChip,
                background: amPm === opt ? "#062B59" : "#F1F5F9",
                color:      amPm === opt ? "#FFFFFF"  : "#64748B",
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Records list */}
      {isLoading ? (
        <p style={{ color: "#64748B", textAlign: "center", padding: 32 }}>Loading…</p>
      ) : listData.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>
          <p style={{ fontSize: 32, margin: "0 0 8px" }}>📄</p>
          <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
            {isOffice ? "No office attendance records yet." : "No visit records yet."}
          </p>
        </div>
      ) : (
        <div style={{ border: "1px solid #DBE5EF", borderRadius: 10, background: "#FFFFFF", overflow: "hidden" }}>
          {listData.map((item, idx) => {
            const tone       = statusTone(item.status);
            const hrs        = fmtHours(item.totalMinutes);
            const inProgress = Boolean(item.timeInAt) && !item.timeOutAt;
            const hasPhotos  = item.logs?.some((l) => l.faceImageData);
            return (
              <button
                key={item.id}
                onClick={() => { setSelected(item); setPhotoTab("TIME_IN"); }}
                style={{
                  ...rowBtn,
                  borderTop: idx === 0 ? "none" : "1px solid #EDF3F8",
                }}
              >
                {/* Top row: date + status badge */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "#062B59", fontWeight: 700, fontSize: 13 }}>
                      {fmtDate(item.attendanceDate)}
                    </span>
                    {!isOffice && item.workLocation?.name && (
                      <span style={{ color: "#64748B", fontSize: 12, fontWeight: 600 }}>
                        · {item.workLocation.name}
                      </span>
                    )}
                    {hasPhotos && <Camera size={12} color="#94A3B8" />}
                  </div>
                  <span style={{
                    background: tone.bg, color: tone.color,
                    fontSize: 10, fontWeight: 700,
                    borderRadius: 999, padding: "3px 7px",
                    display: "flex", alignItems: "center", gap: 3,
                  }}>
                    {tone.icon} {item.status.replace("_", " ")}
                  </span>
                </div>

                {/* Bottom row: time in → time out → hours */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ color: "#94A3B8", fontSize: 11, fontWeight: 600, margin: 0 }}>
                      {isOffice ? "Time In" : "Visit Start"}
                    </p>
                    <p style={{ color: "#334155", fontSize: 14, fontWeight: 700, margin: "2px 0 0" }}>
                      {fmtTime(item.timeInAt)}
                    </p>
                  </div>
                  <ArrowRight size={14} color="#CBD5E1" />
                  <div style={{ flex: 1 }}>
                    <p style={{ color: "#94A3B8", fontSize: 11, fontWeight: 600, margin: 0 }}>
                      {isOffice ? "Time Out" : "Visit End"}
                    </p>
                    <p style={{ color: "#334155", fontSize: 14, fontWeight: 700, margin: "2px 0 0" }}>
                      {fmtTime(item.timeOutAt)}
                    </p>
                  </div>
                  <div style={{ flex: 1.2, textAlign: "right" }}>
                    <p style={{ color: "#94A3B8", fontSize: 11, fontWeight: 600, margin: 0 }}>Hours Rendered</p>
                    <p style={{
                      fontSize: 15, fontWeight: 800, margin: "2px 0 0",
                      color: hrs ? "#17A34A" : "#94A3B8",
                    }}>
                      {hrs ?? (inProgress ? "In progress" : "--")}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Photo modal ──────────────────────────────────────────────────────── */}
      {selected && (
        <div style={overlayS}>
          <div style={modalCard}>
            {/* Title */}
            <p style={{ color: "#062B59", fontSize: 15, fontWeight: 800, textAlign: "center", marginBottom: 14 }}>
              {fmtDate(selected.attendanceDate)}
              {!isOffice && selected.workLocation?.name ? ` · ${selected.workLocation.name}` : ""}
            </p>

            {/* Time-In / Time-Out sub-tabs */}
            <div style={tabSwitcher}>
              {(["TIME_IN", "TIME_OUT"] as const).map((lt) => (
                <button
                  key={lt}
                  onClick={() => setPhotoTab(lt)}
                  style={{
                    ...tabBtn,
                    background: photoTab === lt ? "#062B59" : "transparent",
                    color:      photoTab === lt ? "#FFFFFF"  : "#64748B",
                  }}
                >
                  {isOffice
                    ? (lt === "TIME_IN" ? "Time In" : "Time Out")
                    : (lt === "TIME_IN" ? "Visit Start" : "Visit End")}
                </button>
              ))}
            </div>

            {/* Photo */}
            {(() => {
              const log = selected.logs.find((l) => l.logType === photoTab);
              const uri = log ? photoUri(log) : null;
              return (
                <div style={{ marginBottom: 14 }}>
                  {log && (
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ color: "#1E3A8A", fontSize: 13, fontWeight: 700 }}>
                        {isOffice
                          ? (photoTab === "TIME_IN" ? "Time In" : "Time Out")
                          : (photoTab === "TIME_IN" ? "Visit Start" : "Visit End")}
                      </span>
                      <span style={{ color: "#94A3B8", fontSize: 12, fontWeight: 600 }}>
                        {fmtLogTime(log.capturedAt)}
                      </span>
                    </div>
                  )}
                  {uri ? (
                    <img
                      src={uri}
                      alt="attendance photo"
                      style={{ width: "100%", aspectRatio: "3/4", borderRadius: 14, objectFit: "contain", background: "#F1F5F9" }}
                    />
                  ) : (
                    <div style={{
                      width: "100%", aspectRatio: "3/4", borderRadius: 14,
                      background: "#F1F5F9",
                      display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center", gap: 8,
                    }}>
                      <Camera size={28} color="#CBD5E1" />
                      <p style={{ color: "#94A3B8", fontSize: 13, fontWeight: 600, margin: 0 }}>No photo captured</p>
                    </div>
                  )}
                </div>
              );
            })()}

            <button
              onClick={() => setSelected(null)}
              style={{ display: "block", width: "100%", height: 46, borderRadius: 12, border: "none", background: "#1680D8", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const tabSwitcher: CSSProperties = {
  display: "flex", background: "#F1F5F9",
  borderRadius: 14, padding: 4, marginBottom: 14,
};
const tabBtn: CSSProperties = {
  flex: 1, paddingTop: 10, paddingBottom: 10,
  borderRadius: 11, border: "none", cursor: "pointer",
  fontSize: 14, fontWeight: 700,
};
const summaryCard: CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  background: "#EFF6FF", borderRadius: 14, padding: 14, marginBottom: 18,
};
const refreshBtn: CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  fontSize: 18, color: "#1680D8", padding: "0 4px",
};
const filterChip: CSSProperties = {
  paddingLeft: 16, paddingRight: 16, paddingTop: 7, paddingBottom: 7,
  borderRadius: 999, border: "none", cursor: "pointer",
  fontSize: 12, fontWeight: 700,
};
const rowBtn: CSSProperties = {
  display: "block", width: "100%",
  padding: "12px 16px",
  border: "none", background: "none",
  cursor: "pointer", textAlign: "left",
};
const overlayS: CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(6,43,89,0.55)", zIndex: 2000,
  display: "flex", alignItems: "center", justifyContent: "center", padding: 12,
};
const modalCard: CSSProperties = {
  width: "100%", maxWidth: 480, maxHeight: "92%",
  overflowY: "auto",
  background: "#fff", borderRadius: 20, padding: 16,
};
