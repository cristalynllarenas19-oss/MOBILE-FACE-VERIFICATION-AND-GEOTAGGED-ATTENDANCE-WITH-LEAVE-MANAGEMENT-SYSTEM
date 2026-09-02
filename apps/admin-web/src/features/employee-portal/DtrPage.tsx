
import { CSSProperties, useMemo, useState } from "react";
import { ArrowRight, Camera, Eye, RefreshCw, X } from "lucide-react";
import { AttendanceHistoryRecord, AttendanceLogPhoto, getAttendanceHistory, getAttendanceRecordPhotos } from "./api";
import type { AuthUser } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { CalendarPicker } from "./components/CalendarPicker";
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
  if (tab === "LUNCH_OUT") return "Start Lunch";
  if (tab === "LUNCH_IN") return "End Lunch";
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
  // The list response never carries photo bytes (see getAttendanceHistory's
  // comment in api.ts) — true while this modal's actual photos are being
  // fetched for the record just opened.
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);

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

  async function openRecord(record: AttendanceHistoryRecord) {
    setSelected(record);
    setPhotoTab("TIME_IN");
    if (!record.hasPhoto) return;
    setIsLoadingPhotos(true);
    try {
      const photos = await getAttendanceRecordPhotos(record.id);
      const photoById = new Map(photos.map((photo) => [photo.id, photo]));
      setSelected((current) =>
        current && current.id === record.id
          ? { ...current, logs: current.logs.map((log) => ({ ...log, ...photoById.get(log.id) })) }
          : current,
      );
    } catch (error) {
      console.error("Failed to load attendance photos", error);
    } finally {
      setIsLoadingPhotos(false);
    }
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

  return (
    <div className="dtr-shell emp-form-page">

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 className="emp-page-title">Daily Time Record</h2>
        <button
          onClick={handleRefresh}
          disabled={isRefresh}
          style={refreshBtn}
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={isRefresh ? "dtr-spin" : undefined} />
        </button>
      </div>

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

      {/* Date range filter (From/To, both tabs) — same CalendarPicker popover
          used for Start/End Date on the Request tab, instead of a native
          <input type="date">. */}
      <div style={dateFilterCard}>
        <div style={dateFilterFields}>
          <CalendarPicker
            value={dateFrom}
            onChange={setDateFrom}
            max={dateTo || todayStr}
            placeholder="From"
          />
          <CalendarPicker
            value={dateTo}
            onChange={setDateTo}
            min={dateFrom || undefined}
            max={todayStr}
            placeholder="To"
            align="right"
          />
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

      {/* Records list — the only part of this page that scrolls; the title,
          tabs, and date filters above it stay fixed in place (see
          .dtr-records-scroll in DtrPage.css). */}
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
          {/* Dense table — a status dot instead of a badge, and an inline bar
              under Hours Rendered (against an 8-hour target once a record is
              closed; an open session just shows the label, since live
              elapsed time isn't tracked here). */}
          <div className="dtr-dense-head">
            <span>Date</span>
            <span>{isOffice ? "Time In → Out" : "Visit Start → End"}</span>
            <span style={{ textAlign: "center" }}>Lunch</span>
            <span>Hours Rendered</span>
            <span />
          </div>
          <div className="dtr-records-scroll emp-scroll-thin">
            {listData.map((item, idx) => {
              const tone       = statusTone(item.status);
              const hrs        = fmtHours(item.totalMinutes);
              const inProgress = Boolean(item.timeInAt) && !item.timeOutAt;
              const hasPhotos  = item.hasPhoto;
              // Against an 8-hour (480-minute) target — only meaningful once
              // a record has a real totalMinutes from the server; an open
              // session shows an empty track rather than a guessed fraction.
              const barPct = item.totalMinutes ? Math.min(100, Math.round((item.totalMinutes / 480) * 100)) : 0;
              return (
                // A <div> here (not <button>) so the explicit "View" button
                // below can nest inside it — a <button> can't contain
                // another <button>. Still fully clickable/keyboard-operable
                // as a row; the View button is the discoverable way in.
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openRecord(item)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRecord(item); } }}
                  className="dtr-dense-row"
                  style={{ borderTop: idx === 0 ? "none" : "1px solid #EDF3F8" }}
                  title={item.status.replace("_", " ")}
                >
                  <span className="dtr-dense-date-cell">
                    <span className="dtr-dense-dot" style={{ background: tone.color }} />
                    <span className="dtr-dense-date-text">
                      <span>{fmtDate(item.attendanceDate)}</span>
                      {!isOffice && item.workLocation?.name && (
                        <span className="dtr-dense-site">{item.workLocation.name}</span>
                      )}
                    </span>
                  </span>

                  <span className="dtr-dense-time">
                    {fmtTime(item.timeInAt)} <ArrowRight size={11} color="#CBD5E1" /> {fmtTime(item.timeOutAt)}
                  </span>

                  <span className="dtr-dense-time dtr-dense-lunch">
                    {isOffice && item.lunchOutAt ? `${fmtTime(item.lunchOutAt)} – ${fmtTime(item.lunchInAt ?? null)}` : "—"}
                  </span>

                  <span className="dtr-dense-bar-wrap">
                    <span className="dtr-dense-bar-label" style={{ color: hrs ? tone.color : inProgress ? tone.color : "#94A3B8" }}>
                      {hrs ?? (inProgress ? "In progress" : "--")}
                    </span>
                    <span className="dtr-dense-bar-track">
                      <span className="dtr-dense-bar-fill" style={{ width: `${barPct}%`, background: tone.color }} />
                    </span>
                  </span>

                  {hasPhotos ? (
                    <button
                      type="button"
                      className="dtr-dense-view-btn"
                      onClick={(e) => { e.stopPropagation(); openRecord(item); }}
                      title="View captured photos"
                    >
                      <Eye size={16} />
                      View
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Photo modal ──────────────────────────────────────────────────────── */}
      {selected && (
        <div style={overlayS}>
          <div className="emp-scroll-thin" style={modalCard}>
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
                  ? [{ key: "LUNCH_OUT", label: "Start Lunch" }]
                  : []),
                ...(isOffice && selected.logs.some((l) => l.logType === "LUNCH_IN")
                  ? [{ key: "LUNCH_IN", label: "End Lunch" }]
                  : []),
              ]}
              value={photoTab}
              onChange={(key) => setPhotoTab(key as PhotoTab)}
              style={{ marginBottom: 14 }}
              dense
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
                  ) : isLoadingPhotos ? (
                    <div style={{
                      width: "100%", height: "34vh", borderRadius: 14,
                      background: "#F1F5F9",
                      display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center", gap: 8,
                    }}>
                      <RefreshCw size={28} color="#CBD5E1" className="dtr-spin" />
                      <p style={{ color: "#94A3B8", fontSize: 13, fontWeight: 600, margin: 0 }}>Loading photo…</p>
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
              style={{ display: "block", width: "100%", height: 46, borderRadius: 12, border: "none", background: "#062B59", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
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
const refreshBtn: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 34, height: 34, flexShrink: 0,
  background: "#FFFFFF", border: "1px solid #DBEAFE", borderRadius: "50%",
  cursor: "pointer", color: "#1680D8",
};
const dateFilterCard: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  background: "#FFFFFF", border: "1px solid #DBE5EF", borderRadius: 14,
  padding: 12, marginBottom: 14,
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};
const dateFilterFields: CSSProperties = { display: "flex", gap: 10, flex: 1 };
const clearDateBtn: CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  height: 48, padding: "0 12px", border: "1px solid #DBE5EF", borderRadius: 12,
  background: "#F8FAFC", color: "#64748B", fontSize: 12, fontWeight: 700,
  cursor: "pointer", flexShrink: 0,
};
const filterChip: CSSProperties = {
  paddingLeft: 16, paddingRight: 16, paddingTop: 7, paddingBottom: 7,
  borderRadius: 999, border: "none", cursor: "pointer",
  fontSize: 12, fontWeight: 700,
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
