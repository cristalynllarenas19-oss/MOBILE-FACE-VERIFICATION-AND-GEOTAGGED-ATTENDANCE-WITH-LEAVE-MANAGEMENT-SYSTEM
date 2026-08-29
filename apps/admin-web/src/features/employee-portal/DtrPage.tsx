
import { CSSProperties, useMemo, useState } from "react";
import { ArrowRight, Calendar, Camera, Clock, RefreshCw, X } from "lucide-react";
import { AttendanceHistoryRecord, AttendanceLogPhoto, getAttendanceHistory } from "./api";
import type { AuthUser } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { buildMapGrid, formatCoordsFallback, formatStampDate, TILE_SIZE } from "./gpsStamp";
import "./DtrPage.css";
import "./EmployeePortal.css";

type Props = { user: AuthUser };
type Tab   = "office" | "field";
type AmPm  = "ALL" | "AM" | "PM";
type PhotoTab = "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";

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
function photoTabLabel(tab: PhotoTab, isOffice: boolean) {
  if (tab === "LUNCH_OUT") return "Lunch Out";
  if (tab === "LUNCH_IN") return "Lunch In";
  if (tab === "TIME_IN") return isOffice ? "Time In" : "Visit Start";
  return isOffice ? "Time Out" : "Visit End";
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
// Local (not UTC) YYYY-MM-DD, so a "2026-08-25" input value lines up with
// attendanceDate regardless of the browser's timezone offset.
function toLocalDateStr(v: string | Date) {
  const d = typeof v === "string" ? new Date(v) : v;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayStr = toLocalDateStr(new Date());

export function DtrPage({ user }: Props) {
  const historyCache = useCachedData<AttendanceHistoryRecord[]>(
    user.employeeId ? CACHE_KEYS.attendanceHistory(user.employeeId) : null,
    () => getAttendanceHistory(user.employeeId!),
  );
  const records    = historyCache.data ?? [];
  const isLoading  = historyCache.isLoading;
  const [isRefresh,   setIsRefresh]   = useState(false);
  const [activeTab,   setActiveTab]   = useState<Tab>("office");
  const [amPm,        setAmPm]        = useState<AmPm>("ALL");
  const [dateFrom,    setDateFrom]    = useState("");
  const [dateTo,      setDateTo]      = useState("");
  const [selected,    setSelected]    = useState<AttendanceHistoryRecord | null>(null);
  const [photoTab,    setPhotoTab]    = useState<PhotoTab>("TIME_IN");

  const activeLog = selected?.logs.find((l) => l.logType === photoTab) ?? null;

  // Attendance photos are stored raw/unwatermarked (see CameraScanner's
  // finishScan) — the GPS stamp is drawn here as a DOM overlay from the
  // log's own permanently stored address (resolved once, server-side, at
  // submission time — see attendance.service.ts submit()). Deliberately
  // never re-geocoded here: a capture is a frozen record, and re-deriving
  // its address live (through whatever geocoding provider happens to be
  // asking) is exactly what let mobile and web disagree on the same log.
  // Every row has a stored address (backfilled for anything captured
  // before this field existed), so the coordinate fallback below is only
  // a last resort, not a normal path.
  const stampAddress = activeLog
    ? activeLog.address ?? formatCoordsFallback(Number(activeLog.latitude), Number(activeLog.longitude))
    : null;

  async function handleRefresh() {
    setIsRefresh(true);
    await historyCache.refresh();
    setIsRefresh(false);
  }

  const hasDateFilter = Boolean(dateFrom || dateTo);
  const withinDateRange = (r: AttendanceHistoryRecord) => {
    if (!hasDateFilter) return true;
    const day = toLocalDateStr(r.attendanceDate);
    if (dateFrom && day < dateFrom) return false;
    if (dateTo && day > dateTo) return false;
    return true;
  };

  const officeRecs = useMemo(
    () => records.filter((r) => r.recordType !== "FIELD" && withinDateRange(r)),
    [records, dateFrom, dateTo],
  );
  const fieldRecs = useMemo(
    () => records.filter((r) => r.recordType === "FIELD" && withinDateRange(r)),
    [records, dateFrom, dateTo],
  );
  const filteredField = useMemo(() => {
    if (amPm === "ALL") return fieldRecs;
    return fieldRecs.filter((r) => isMorning(r.timeInAt) === (amPm === "AM"));
  }, [fieldRecs, amPm]);

  const isOffice     = activeTab === "office";
  const listData     = isOffice ? officeRecs : filteredField;
  // Summary card always reflects today regardless of the date-range filter —
  // computed from the unfiltered record set, matching mobile's DTRScreen.
  const todayRecord  = isOffice
    ? latestOfToday(records.filter((r) => r.recordType !== "FIELD"))
    : latestOfToday(records.filter((r) => r.recordType === "FIELD"));
  const todayInProg  = Boolean(todayRecord?.timeInAt) && !todayRecord?.timeOutAt;

  return (
    <div className="dtr-shell emp-form-page">

      <h2 className="emp-page-title">Daily Time Record</h2>

      {/* Tab switcher */}
      <SegmentedControl
        segments={[
          { key: "office", label: "Office" },
          { key: "field", label: "Field" },
        ]}
        value={activeTab}
        onChange={(key) => setActiveTab(key as Tab)}
        style={{ marginBottom: 14 }}
      />

      {/* Date range filter (From/To, both tabs) */}
      <div style={dateFilterCard}>
        <div style={dateFilterFields}>
          <label style={dateFieldLabel}>
            <span style={dateFieldLabelText}><Calendar size={11} /> From</span>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || todayStr}
              onChange={(e) => setDateFrom(e.target.value)}
              style={dateInput}
            />
          </label>
          <label style={dateFieldLabel}>
            <span style={dateFieldLabelText}><Calendar size={11} /> To</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              max={todayStr}
              onChange={(e) => setDateTo(e.target.value)}
              style={dateInput}
            />
          </label>
        </div>
        {hasDateFilter && (
          <button
            type="button"
            onClick={() => { setDateFrom(""); setDateTo(""); }}
            style={clearDateBtn}
            aria-label="Clear date range"
          >
            <X size={13} /> Clear
          </button>
        )}
      </div>

      {/* Summary card */}
      <div style={summaryCard}>
        <div style={summaryIconWrap}>
          <Clock size={18} color="#1680D8" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={summaryLabel}>
            {isOffice ? "Today's Hours Rendered" : "Today's Hours Rendered (Latest Visit)"}
          </p>
          <p style={summaryValue}>
            {todayRecord
              ? fmtHours(todayRecord.totalMinutes) ?? (todayInProg ? "In progress" : "--")
              : isOffice ? "Not yet timed in" : "No visit started"}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefresh}
          style={refreshBtn}
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={isRefresh ? "dtr-spin" : undefined} />
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
            {hasDateFilter
              ? "No attendance records in this date range."
              : isOffice ? "No office attendance records yet." : "No visit records yet."}
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

                {isOffice && item.lunchOutAt && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span style={{ color: "#9A3412", fontSize: 12, fontWeight: 600 }}>
                      Lunch: {fmtTime(item.lunchOutAt)} - {fmtTime(item.lunchInAt ?? null)}
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Photo modal ──────────────────────────────────────────────────────── */}
      {selected && (
        <div style={overlayS}>
          <div style={modalCard}>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={modalCloseBtn}
              aria-label="Close"
            >
              <X size={15} color="#64748B" />
            </button>

            {/* Title */}
            <p style={{ color: "#062B59", fontSize: 15, fontWeight: 800, textAlign: "center", marginBottom: 14, paddingRight: 28 }}>
              {fmtDate(selected.attendanceDate)}
              {!isOffice && selected.workLocation?.name ? ` · ${selected.workLocation.name}` : ""}
            </p>

            {/* Time-In / Time-Out sub-tabs */}
            <SegmentedControl
              segments={[
                { key: "TIME_IN", label: photoTabLabel("TIME_IN", isOffice) },
                { key: "TIME_OUT", label: photoTabLabel("TIME_OUT", isOffice) },
                ...(isOffice && selected.logs.some((l) => l.logType === "LUNCH_OUT")
                  ? [{ key: "LUNCH_OUT", label: "Lunch Out" }]
                  : []),
                ...(isOffice && selected.logs.some((l) => l.logType === "LUNCH_IN")
                  ? [{ key: "LUNCH_IN", label: "Lunch In" }]
                  : []),
              ]}
              value={photoTab}
              onChange={(key) => setPhotoTab(key as PhotoTab)}
              style={{ marginBottom: 14 }}
            />

            {/* Photo */}
            {(() => {
              const uri = activeLog ? photoUri(activeLog) : null;
              const stampTiles = activeLog
                ? buildMapGrid(Number(activeLog.latitude), Number(activeLog.longitude), 60)
                : null;
              return (
                <div style={{ marginBottom: 14, textAlign: "center" }}>
                  {uri ? (
                    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
                      <img
                        src={uri}
                        alt="attendance photo"
                        style={{
                          display: "block",
                          maxWidth: "100%", maxHeight: "44vh",
                          width: "auto", height: "auto",
                          borderRadius: 14, objectFit: "contain", background: "#F1F5F9",
                        }}
                      />
                      {/* GPS stamp overlay — same idea as CameraScanner's
                          gpsRow, rendered from this log's own stored
                          lat/lon/timestamp since the photo itself is raw. */}
                      {stampTiles && activeLog && (
                        <div style={{
                          position: "absolute", left: 10, right: 10, bottom: 10,
                          display: "flex", alignItems: "flex-end", gap: 8,
                          pointerEvents: "none",
                        }}>
                          <div style={{
                            position: "relative", width: 60, height: 60, flexShrink: 0,
                            borderRadius: 10, overflow: "hidden",
                            border: "2px solid #FFFFFF", background: "#CBD5E1",
                          }}>
                            {stampTiles.map((cell) => (
                              <img
                                key={cell.key}
                                src={cell.url}
                                alt=""
                                style={{ position: "absolute", left: cell.left, top: cell.top, width: TILE_SIZE, height: TILE_SIZE }}
                              />
                            ))}
                            <div style={{
                              position: "absolute", left: 26, top: 18,
                              width: 8, height: 8, borderRadius: "50%",
                              background: "#DC2626", boxShadow: "0 0 0 2px #fff",
                            }} />
                          </div>
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                            <div style={{
                              alignSelf: "flex-start",
                              background: "#DC2626", color: "#FFFFFF",
                              padding: "3px 8px", borderRadius: 6,
                              fontSize: 10, fontWeight: 800,
                            }}>
                              {photoTabLabel(photoTab, isOffice).toUpperCase()} · {formatStampDate(new Date(activeLog.capturedAt))}
                            </div>
                            <div style={{
                              color: "#FFFFFF", fontSize: 10, fontWeight: 700,
                              textShadow: "0 1px 4px rgba(0,0,0,0.85)",
                              overflow: "hidden", display: "-webkit-box",
                              WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                            }}>
                              {stampAddress ?? "Locating…"}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{
                      width: "100%", height: "34vh", borderRadius: 14,
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
const summaryCard: CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  background: "#EFF6FF", border: "1px solid #DBEAFE",
  borderRadius: 14, padding: 14, marginBottom: 18,
};
const summaryIconWrap: CSSProperties = {
  width: 38, height: 38, borderRadius: "50%",
  background: "#FFFFFF",
  display: "flex", alignItems: "center", justifyContent: "center",
  flexShrink: 0,
  boxShadow: "0 1px 3px rgba(15,23,42,0.12)",
};
const summaryLabel: CSSProperties = { color: "#1E3A8A", fontSize: 12, fontWeight: 700, margin: 0 };
const summaryValue: CSSProperties = { color: "#062B59", fontSize: 20, fontWeight: 800, margin: "2px 0 0" };
const refreshBtn: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 34, height: 34, flexShrink: 0,
  background: "#FFFFFF", border: "1px solid #DBEAFE", borderRadius: "50%",
  cursor: "pointer", color: "#1680D8",
};
const dateFilterCard: CSSProperties = {
  display: "flex", alignItems: "flex-end", gap: 10,
  background: "#FFFFFF", border: "1px solid #DBE5EF", borderRadius: 14,
  padding: 12, marginBottom: 14,
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};
const dateFilterFields: CSSProperties = { display: "flex", gap: 10, flex: 1 };
const dateFieldLabel: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 5, flex: 1,
};
const dateFieldLabelText: CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  fontSize: 10.5, fontWeight: 700, color: "#64748B",
  textTransform: "uppercase", letterSpacing: 0.03,
};
const dateInput: CSSProperties = {
  width: "100%", height: 36, border: "1px solid #DBE5EF", borderRadius: 9,
  padding: "0 8px", fontSize: 12.5, fontWeight: 600, color: "#062B59",
  background: "#F8FAFC", outline: "none", boxSizing: "border-box",
};
const clearDateBtn: CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  height: 36, padding: "0 10px", border: "1px solid #DBE5EF", borderRadius: 9,
  background: "#F8FAFC", color: "#64748B", fontSize: 12, fontWeight: 700,
  cursor: "pointer", flexShrink: 0,
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
  position: "relative",
};
const modalCloseBtn: CSSProperties = {
  position: "absolute", top: 12, right: 12,
  width: 28, height: 28, borderRadius: "50%",
  border: "none", background: "#F1F5F9",
  display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", zIndex: 1,
};
