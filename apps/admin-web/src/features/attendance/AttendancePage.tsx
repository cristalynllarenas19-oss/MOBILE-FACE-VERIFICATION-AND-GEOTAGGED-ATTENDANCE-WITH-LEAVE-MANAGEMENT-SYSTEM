import { useEffect, useState } from "react";
import { CheckCircle2, Eye, MapPin, X, XCircle } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { EmployeeSearchSelect, matchesEmployeeQuery, type EmployeeSearchOption } from "../../components/ui/EmployeeSearchSelect";
import { NotificationModal, type NotificationConfig } from "../../components/ui/NotificationModal";
import { apiRequest } from "../../lib/api";
import { useCachedData } from "../../lib/dataCache";
import { useActiveDepartments } from "../../lib/departments";
import { PermissionCode, permissions } from "../../types/rbac";
import "./AttendancePage.css";

type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "ON_LEAVE" | "PENDING_REVIEW" | "FLAGGED" | "FLAGGED_REJECTED";

const ATTENDANCE_PAGE_SIZE = 10;

type PhotoLogType = "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";

type AttendanceLog = {
  id?: string;
  logType: PhotoLogType;
  latitude: string;
  longitude: string;
  distanceFromSiteMeters: string;
  faceSimilarityScore?: string | null;
  verificationStatus: string;
  capturedAt: string;
  failureReason?: string | null;
  faceImageData?: string | null;
  faceImageMimeType?: string | null;
};

type AttendanceRecord = {
  id: string;
  attendanceDate: string;
  timeInAt?: string | null;
  timeOutAt?: string | null;
  lunchOutAt?: string | null;
  lunchInAt?: string | null;
  // "BREAK" when the record's shift break isn't a lunch (night/evening shifts).
  breakKind?: "LUNCH" | "BREAK";
  status: AttendanceStatus;
  recordType?: "OFFICE" | "FIELD";
  visitNumber?: number;
  workLocation?: { name: string } | null;
  employee: {
    employeeNo?: string;
    firstName: string;
    lastName: string;
    department: { name: string };
    position?: { title: string } | null;
    user?: { userRoles: { role: { code: string } }[] } | null;
    faceProfiles?: { referenceImageData?: string | null }[];
  };
  logs: AttendanceLog[];
  adminRemarks?: { remarks?: string } | null;
  isSynthetic?: boolean;
  leaveTypeName?: string;
  // A synthetic row built from a flagged AttendanceLog (face mismatch,
  // geofence passed) that has no AttendanceRecord yet — see
  // flaggedLogToRecord() below. flaggedLogId is the real AttendanceLog id
  // the review actions (validate/reject) act on.
  isFlagged?: boolean;
  flaggedLogId?: string;
  // A flagged attempt a reviewer already rejected as fake — shown read-only.
  isRejected?: boolean;
  reviewRemarks?: string | null;
};

// Shape of GET /attendance/records/:id/review-photos — the photos GET
// /attendance leaves out of the list, loaded when a record's modal opens.
type RecordReviewPhotos = {
  registeredFace: string | null;
  logs: { id: string; faceImageData: string | null; faceImageMimeType: string | null }[];
};

// Shape of GET /attendance/flagged — raw AttendanceLog rows awaiting an
// admin/supervisor decision, with no AttendanceRecord attached yet.
type FlaggedLog = {
  id: string;
  logType: PhotoLogType;
  capturedAt: string;
  attendanceDate?: string | null;
  recordType?: "OFFICE" | "FIELD" | null;
  latitude: string;
  longitude: string;
  distanceFromSiteMeters: string;
  faceSimilarityScore?: string | null;
  verificationStatus: string;
  failureReason?: string | null;
  faceImageData?: string | null;
  faceImageMimeType?: string | null;
  workLocation?: { name: string } | null;
  employee: AttendanceRecord["employee"];
  // Set once reviewed — only on the GET /attendance/flagged?status=REJECTED rows.
  reviewRemarks?: string | null;
};

// Shape of GET /attendance/logs/:id/review — a clicked attendance
// notification's attempt (see AttendancePage's initialFocusLogId effect).
type FocusedLog =
  | { kind: "record"; record: AttendanceRecord }
  | { kind: "flagged"; log: FlaggedLog; reviewed: boolean };

type EmployeeOption = EmployeeSearchOption;

// No separate "Pending Review" option: no record is ever stored as
// PENDING_REVIEW, so it only ever listed the same unresolved attempts as
// Flagged (labelled "Flagged – Pending Review"). FLAGGED_REJECTED lists the
// flagged attempts a reviewer has since rejected as fake.
const statusOptions = ["PRESENT", "LATE", "ABSENT", "ON_LEAVE", "FLAGGED", "FLAGGED_REJECTED"];
const recordTypeOptions = ["OFFICE", "FIELD"];

function getRecordTypeLabel(recordType: string) {
  return recordType === "FIELD" ? "Field" : "Non-field";
}

function flaggedLogToRecord(log: FlaggedLog, rejected = false): AttendanceRecord {
  return {
    id: `flagged-${log.id}`,
    attendanceDate: log.attendanceDate ?? log.capturedAt,
    timeInAt: null,
    timeOutAt: null,
    lunchOutAt: null,
    lunchInAt: null,
    status: rejected ? "FLAGGED_REJECTED" : "FLAGGED",
    isRejected: rejected,
    reviewRemarks: log.reviewRemarks ?? null,
    recordType: log.recordType ?? undefined,
    workLocation: log.workLocation ?? null,
    employee: log.employee,
    logs: [
      {
        logType: log.logType,
        latitude: log.latitude,
        longitude: log.longitude,
        distanceFromSiteMeters: log.distanceFromSiteMeters,
        faceSimilarityScore: log.faceSimilarityScore,
        verificationStatus: log.verificationStatus,
        capturedAt: log.capturedAt,
        failureReason: log.failureReason,
        faceImageData: log.faceImageData,
        faceImageMimeType: log.faceImageMimeType,
      },
    ],
    isFlagged: true,
    flaggedLogId: log.id,
  };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

// "Pending" implies attendance is still expected but hasn't happened yet —
// only true while a record is genuinely awaiting review (FLAGGED, the
// synthetic status for an unresolved AttendanceLog; PENDING_REVIEW is kept
// here too even though no real AttendanceRecord ever persists that value —
// see AttendancePage's status-filter comment). An approved leave or a
// genuine no-show (ON_LEAVE/ABSENT) means no attendance was ever expected to
// be recorded here, so it reads as "—" instead. A real PRESENT/LATE
// record with a timestamp still missing (e.g. not yet
// timed out) also reads as "—", not "Pending".
function formatTime(value: string | null | undefined, status?: AttendanceStatus) {
  if (status === "ON_LEAVE" || status === "ABSENT") return "—";
  if (value) return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return status === "FLAGGED" || status === "PENDING_REVIEW" ? "Pending" : "—";
}

function getName(record: AttendanceRecord) {
  return `${record.employee.firstName} ${record.employee.lastName}`;
}

// A Supervisor or Admin logs attendance like any other employee, so their
// highest role is shown rather than their position title; everyone else
// shows their position, or plain "Employee" when none is assigned.
function getPositionLabel(employee: AttendanceRecord["employee"]) {
  const roleCodes = employee.user?.userRoles.map((userRole) => userRole.role.code) ?? [];
  if (roleCodes.includes("ADMIN")) return "Admin";
  if (roleCodes.includes("SUPERVISOR")) return "Supervisor";
  return employee.position?.title ?? "Employee";
}

function getStatusTone(status: AttendanceStatus) {
  if (status === "PRESENT") return "success";
  if (status === "ABSENT" || status === "FLAGGED" || status === "FLAGGED_REJECTED") return "danger";
  return "warning";
}

function getStatusLabel(status: string) {
  if (status === "FLAGGED") return "Flagged – Pending Review";
  if (status === "FLAGGED_REJECTED") return "Flagged – Rejected";
  return status.replace(/_/g, " ");
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);
  return now;
}

function formatTodayLabel(date: Date) {
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

const photoTabOrder: PhotoLogType[] = ["TIME_IN", "TIME_OUT", "LUNCH_OUT", "LUNCH_IN"];

function photoTabLabel(tab: PhotoLogType, breakWord = "Lunch", isField = false) {
  if (tab === "TIME_IN") return isField ? "Start Visit" : "Time In";
  if (tab === "TIME_OUT") return isField ? "End Visit" : "Time Out";
  if (tab === "LUNCH_OUT") return `Start ${breakWord}`;
  return `End ${breakWord}`;
}

function photoUri(log?: AttendanceLog | null) {
  if (!log?.faceImageData) return null;
  return `data:${log.faceImageMimeType ?? "image/jpeg"};base64,${log.faceImageData}`;
}

// "1st", "2nd", "3rd" — which same-day failed attempt a flagged capture was.
function ordinal(value: number) {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10] ?? "th";
  return `${value}${suffix}`;
}

function isFailedAttendanceAttempt(log?: AttendanceLog | null) {
  return log?.verificationStatus === "REJECTED";
}

function AttendanceDetailsModal({
  record,
  onClose,
  onUpdated,
  onFlaggedResolved,
  canWrite,
}: {
  record: AttendanceRecord;
  onClose: () => void;
  onUpdated: (record: AttendanceRecord, title: string, message: string) => void;
  onFlaggedResolved: (title: string, message: string) => void;
  canWrite: boolean;
}) {
  const [remarks, setRemarks] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  // Enlarged view of whichever photo was clicked (registered or captured).
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // A real record's photos aren't in the list response — fetch them now.
  // Flagged rows still carry theirs inline; synthetic rows have none.
  const needsPhotos = !record.isFlagged && !record.isSynthetic;
  const [reviewPhotos, setReviewPhotos] = useState<RecordReviewPhotos | null>(null);
  useEffect(() => {
    if (!needsPhotos) return;
    let cancelled = false;
    apiRequest<RecordReviewPhotos>(`/attendance/records/${record.id}/review-photos`)
      .then((photos) => {
        if (!cancelled) setReviewPhotos(photos);
      })
      .catch(() => {
        if (!cancelled) setReviewPhotos({ registeredFace: null, logs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, needsPhotos]);
  const isLoadingPhotos = needsPhotos && reviewPhotos === null;
  const logs = reviewPhotos
    ? record.logs.map((log) => {
        const photo = reviewPhotos.logs.find((item) => item.id === log.id);
        return photo ? { ...log, faceImageData: photo.faceImageData, faceImageMimeType: photo.faceImageMimeType } : log;
      })
    : record.logs;
  const registeredFace = reviewPhotos ? reviewPhotos.registeredFace : record.employee.faceProfiles?.[0]?.referenceImageData;

  const breakWord = record.breakKind === "BREAK" ? "Break" : "Lunch";
  // A field visit is a Start/End Visit pair with no lunch/break punches.
  const isFieldRecord = record.recordType === "FIELD";
  const availablePhotoTabs = photoTabOrder.filter((tab) => logs.some((log) => log.logType === tab));
  const [activePhotoTab, setActivePhotoTab] = useState<PhotoLogType>(availablePhotoTabs[0] ?? "TIME_IN");
  const latestLog = logs.find((log) => log.logType === activePhotoTab) ?? logs[0];

  // A flagged row only carries the latest failed attempt; the earlier
  // same-day ones it superseded are fetched here (oldest first) so the
  // reviewer can still flip back to them. null = showing the latest.
  const [previousAttempts, setPreviousAttempts] = useState<AttendanceLog[]>([]);
  const [viewedAttempt, setViewedAttempt] = useState<number | null>(null);
  useEffect(() => {
    if (!record.flaggedLogId) return;
    let cancelled = false;
    apiRequest<AttendanceLog[]>(`/attendance/flagged/${record.flaggedLogId}/attempts`)
      .then((attempts) => {
        if (!cancelled) setPreviousAttempts(attempts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [record.flaggedLogId]);
  const latestAttemptNumber = previousAttempts.length + 1;
  const selectedLog = (viewedAttempt !== null ? previousAttempts[viewedAttempt] : undefined) ?? latestLog;
  const attemptLabel = !record.isFlagged
    ? ""
    : viewedAttempt !== null
      ? `${ordinal(viewedAttempt + 1)} attempt`
      : `${ordinal(latestAttemptNumber)} attempt · Latest`;
  const canApproveFailedAttempt = isFailedAttendanceAttempt(selectedLog);
  const mapQuery = selectedLog ? `${selectedLog.latitude},${selectedLog.longitude}` : "";

  const updateStatus = async (action: "approve") => {
    setIsSaving(true);
    setError("");
    try {
      const updated = await apiRequest<AttendanceRecord>(`/attendance/${record.id}/${action}`, {
        method: "PATCH",
        body: JSON.stringify({ remarks: remarks.trim() }),
      });
      const suffix = remarks.trim() ? ` Remarks noted: ${remarks.trim()}` : "";
      onUpdated(updated, "Attendance Approved", `Attendance was approved.${suffix}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update attendance.");
    } finally {
      setIsSaving(false);
    }
  };

  const reviewFlagged = async (decision: "validate" | "reject") => {
    if (!record.flaggedLogId) return;
    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/attendance/flagged/${record.flaggedLogId}/${decision}`, {
        method: "PATCH",
        body: JSON.stringify({ remarks: remarks.trim() }),
      });
      const suffix = remarks.trim() ? ` Remarks noted: ${remarks.trim()}` : "";
      onFlaggedResolved(
        decision === "validate" ? "Attempt Validated" : "Marked as Fake Attempt",
        decision === "validate"
          ? `Attendance attempt was validated and recorded.${suffix}`
          : `Attendance attempt was tagged as a fake attendance attempt.${suffix}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to review this attendance attempt.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="attendance-modal-backdrop" role="presentation">
      <section
        className={`attendance-modal${record.isSynthetic ? " attendance-modal--single" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attendance-modal-title"
      >
        <div className="attendance-modal-header">
          <div>
            <h2 id="attendance-modal-title">Attendance Details</h2>
            <p>{formatDate(record.attendanceDate)}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={isSaving} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Two columns: photo comparison + verification on the left, record
            details on the right — sized to fit without scrolling. */}
        <div className="attendance-modal-body">
          {!record.isSynthetic && (
            <div className="attendance-modal-col">
              {/* A lone tab has nothing to switch to, and the capture's own
                  caption already names it. */}
              {availablePhotoTabs.length > 1 && (
                <div className="attendance-photo-tabs">
                  {availablePhotoTabs.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={`attendance-photo-tab${activePhotoTab === tab ? " active" : ""}`}
                      onClick={() => setActivePhotoTab(tab)}
                    >
                      {photoTabLabel(tab, breakWord, isFieldRecord)}
                    </button>
                  ))}
                </div>
              )}

              {previousAttempts.length > 0 && (
                <div className="attendance-photo-tabs attendance-attempt-tabs">
                  {previousAttempts.map((attempt, index) => (
                    <button
                      key={attempt.capturedAt}
                      type="button"
                      className={`attendance-photo-tab${viewedAttempt === index ? " active" : ""}`}
                      onClick={() => setViewedAttempt(index)}
                    >
                      {ordinal(index + 1)} attempt
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`attendance-photo-tab${viewedAttempt === null ? " active" : ""}`}
                    onClick={() => setViewedAttempt(null)}
                  >
                    {ordinal(latestAttemptNumber)} attempt
                  </button>
                </div>
              )}

              <div className="attendance-compare">
                <figure className="attendance-compare-item">
                  <figcaption>Registered Face</figcaption>
                  {registeredFace ? (
                    <button type="button" className="attendance-compare-photo" onClick={() => setPreviewImage(registeredFace)}>
                      <img src={registeredFace} alt="Registered face" />
                    </button>
                  ) : (
                    <div className="attendance-compare-photo attendance-photo-empty">{isLoadingPhotos ? "Loading…" : "Not stored"}</div>
                  )}
                </figure>
                <figure className="attendance-compare-item">
                  <figcaption>{photoTabLabel(activePhotoTab, breakWord, isFieldRecord)} Capture</figcaption>
                  {photoUri(selectedLog) ? (
                    <button
                      type="button"
                      className="attendance-compare-photo"
                      onClick={() => setPreviewImage(photoUri(selectedLog))}
                    >
                      {attemptLabel && <span className="attendance-attempt-label">{attemptLabel}</span>}
                      <img src={photoUri(selectedLog) ?? undefined} alt={`${photoTabLabel(activePhotoTab, breakWord, isFieldRecord)} capture`} />
                    </button>
                  ) : (
                    <div className="attendance-compare-photo attendance-photo-empty">{isLoadingPhotos ? "Loading…" : "No photo captured"}</div>
                  )}
                </figure>
              </div>

              {/* The one number the reviewer is here to judge. */}
              <div className="attendance-match">
                <strong>{selectedLog?.faceSimilarityScore ? `${selectedLog.faceSimilarityScore}%` : "N/A"}</strong>
                <div>
                  <span>Face match score{attemptLabel ? ` · ${attemptLabel}` : ""}</span>
                  <em>{selectedLog?.verificationStatus ? getStatusLabel(selectedLog.verificationStatus) : "No log"}</em>
                </div>
              </div>

              <div className="attendance-rows">
                <div><span>Captured at</span><strong>{selectedLog ? new Date(selectedLog.capturedAt).toLocaleString() : "No log"}</strong></div>
                <div><span>Failure reason</span><strong>{selectedLog?.failureReason ?? "None"}</strong></div>
              </div>
            </div>
          )}

          <div className="attendance-modal-col">
            {record.isSynthetic && (
              <p className="attendance-synthetic-note">
                No attendance record — this employee is marked {getStatusLabel(record.status).toLowerCase()} for this date.
              </p>
            )}

            <div className="attendance-section-title">Employee</div>
            <div className="attendance-rows">
              <div><span>Name</span><strong>{getName(record)}</strong></div>
              <div><span>Position</span><strong>{getPositionLabel(record.employee)}</strong></div>
              <div><span>Department</span><strong>{record.employee.department.name}</strong></div>
            </div>

            <div className="attendance-section-title">Attendance</div>
            <div className="attendance-rows">
              <div><span>Status</span><Badge tone={getStatusTone(record.status)}>{getStatusLabel(record.status)}</Badge></div>
              {record.status === "ON_LEAVE" && (
                <div><span>Leave type</span><strong>{record.leaveTypeName ?? "—"}</strong></div>
              )}
            </div>
            {isFieldRecord ? (
              <div className="attendance-times attendance-times--visit">
                <div><span>Start Visit</span><strong>{formatTime(record.timeInAt, record.status)}</strong></div>
                <div><span>End Visit</span><strong>{formatTime(record.timeOutAt, record.status)}</strong></div>
              </div>
            ) : (
              <div className="attendance-times">
                <div><span>Time In</span><strong>{formatTime(record.timeInAt, record.status)}</strong></div>
                <div><span>Start {breakWord}</span><strong>{formatTime(record.lunchOutAt, record.status)}</strong></div>
                <div><span>End {breakWord}</span><strong>{formatTime(record.lunchInAt, record.status)}</strong></div>
                <div><span>Time Out</span><strong>{formatTime(record.timeOutAt, record.status)}</strong></div>
              </div>
            )}

            <div className="attendance-section-title">Location</div>
            <div className="attendance-rows">
              <div><span>Site</span><strong>{record.workLocation?.name ?? "—"}</strong></div>
              {!record.isSynthetic && (
                <>
                  <div><span>Distance from site</span><strong>{selectedLog ? `${Math.round(Number(selectedLog.distanceFromSiteMeters))}m` : "No log"}</strong></div>
                  <div>
                    <span>Coordinates</span>
                    {selectedLog ? (
                      <a className="attendance-map-link" href={`https://www.google.com/maps?q=${mapQuery}`} target="_blank" rel="noreferrer">
                        <MapPin size={13} /> {selectedLog.latitude}, {selectedLog.longitude}
                      </a>
                    ) : (
                      <strong>No log</strong>
                    )}
                  </div>
                  {/* A pending flagged attempt has no AttendanceRecord yet, so
                      there's no remark to show; a rejected one shows the
                      reviewer's. */}
                  {!record.isFlagged && (
                    <div><span>Remarks</span><strong>{record.adminRemarks?.remarks ?? "None"}</strong></div>
                  )}
                  {record.isRejected && (
                    <div><span>Rejection Remarks</span><strong>{record.reviewRemarks || "None"}</strong></div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="attendance-admin-actions">
          {error && <p className="attendance-form-error">{error}</p>}
          <div>
            {canWrite && record.isFlagged && !record.isRejected && (
              <>
                <button className="attendance-reject-button" onClick={() => reviewFlagged("reject")} disabled={isSaving}>
                  <XCircle size={15} />
                  Reject as Fake Attempt
                </button>
                <button className="primary-button attendance-validate-button" onClick={() => reviewFlagged("validate")} disabled={isSaving}>
                  <CheckCircle2 size={15} />
                  Validate as Legitimate
                </button>
              </>
            )}
            {canWrite && !record.isFlagged && !record.isSynthetic && canApproveFailedAttempt && (
              <button className="primary-button" onClick={() => updateStatus("approve")} disabled={isSaving}>Approve</button>
            )}
            <button className="outline-button" onClick={onClose} disabled={isSaving}>Close</button>
          </div>
        </div>
      </section>

      {previewImage && (
        <div className="attendance-face-preview-backdrop" role="presentation" onClick={() => setPreviewImage(null)}>
          <button
            className="icon-button attendance-face-preview-close"
            onClick={() => setPreviewImage(null)}
            aria-label="Close photo preview"
          >
            <X size={18} />
          </button>
          <img className="attendance-face-preview-image" src={previewImage} alt="Enlarged photo" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

export type AttendanceInitialFilter = { department?: string; status?: string; date?: string };

export function AttendancePage({
  user,
  initialFilter,
  initialFocusLogId,
  onFocusHandled,
}: {
  user?: { permissions: PermissionCode[]; roles?: string[]; departmentId?: string; department?: string };
  initialFilter?: AttendanceInitialFilter;
  // Set when arriving here from a clicked flagged-attendance notification —
  // opens that log's review modal directly instead of landing on the plain
  // list.
  initialFocusLogId?: string;
  onFocusHandled?: () => void;
}) {
  const canWrite = user?.permissions.includes(permissions.attendanceWrite) ?? true;
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");

  const [departmentFilter, setDepartmentFilter] = useState(initialFilter?.department ?? "ALL");
  const [statusFilter, setStatusFilter] = useState(initialFilter?.status ?? "ALL");
  const [recordTypeFilter, setRecordTypeFilter] = useState("ALL");
  const [dateFrom, setDateFrom] = useState(initialFilter?.date ?? "");
  const [dateTo, setDateTo] = useState(initialFilter?.date ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [viewRecord, setViewRecord] = useState<AttendanceRecord | null>(null);
  const [notification, setNotification] = useState<NotificationConfig>(null);
  const now = useNow();

  const fetchRecords = async () => {
    const params = new URLSearchParams();
    if (departmentFilter !== "ALL") params.set("department", departmentFilter);
    const isFlaggedFilter = statusFilter === "FLAGGED" || statusFilter === "PENDING_REVIEW";
    const isRejectedFilter = statusFilter === "FLAGGED_REJECTED";
    if (statusFilter !== "ALL" && !isFlaggedFilter && !isRejectedFilter) {
      params.set("status", statusFilter);
    }
    if (recordTypeFilter !== "ALL") params.set("recordType", recordTypeFilter);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);

    const query = params.toString();
    // Flagged attempts (face mismatch, geofence passed) live on
    // AttendanceLog with no AttendanceRecord yet, so they're fetched
    // separately and merged in as synthetic rows — see flaggedLogToRecord().
    // AttendanceRecord.status is never actually persisted as PENDING_REVIEW
    // (every real record is written as PRESENT/LATE — see
    // AttendanceService.submit/updateStatus), so "Pending Review" in this
    // dropdown is the same underlying data as "Flagged": an AttendanceLog
    // still awaiting an admin decision.
    // "Flagged – Rejected" lists only the attempts a reviewer rejected, from
    // the same endpoint with status=REJECTED; "All" leaves them out, since
    // they never became attendance.
    const wantsRecords = !isFlaggedFilter && !isRejectedFilter;
    const wantsFlagged = statusFilter === "ALL" || isFlaggedFilter || isRejectedFilter;

    const [fetchedRecords, flaggedLogs] = await Promise.all([
      wantsRecords
        ? apiRequest<AttendanceRecord[]>(`/attendance${query ? `?${query}` : ""}`).catch(() => [] as AttendanceRecord[])
        : Promise.resolve<AttendanceRecord[]>([]),
      wantsFlagged
        ? apiRequest<FlaggedLog[]>(`/attendance/flagged${isRejectedFilter ? "?status=REJECTED" : ""}`).catch(
            () => [] as FlaggedLog[],
          )
        : Promise.resolve<FlaggedLog[]>([]),
    ]);
    // /attendance/flagged takes no filters, so the date range and type are
    // applied here — otherwise flagged attempts from any date would show up
    // inside a narrower range.
    const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    const flaggedRecords = flaggedLogs
      .filter((log) => departmentFilter === "ALL" || log.employee.department.name === departmentFilter)
      .map((log) => flaggedLogToRecord(log, isRejectedFilter))
      .filter((record) => {
        if (recordTypeFilter !== "ALL" && record.recordType !== recordTypeFilter) return false;
        const time = new Date(record.attendanceDate).getTime();
        if (fromTime !== null && time < fromTime) return false;
        if (toTime !== null && time > toTime) return false;
        return true;
      });
    // Newest date first across both sources (a stable sort, so same-date
    // ties keep flaggedRecords ahead of fetchedRecords, and fetchedRecords
    // keep the backend's own ordering) — otherwise flagged rows from any
    // past date would always float above today's other records.
    return [...flaggedRecords, ...fetchedRecords].sort(
      (a, b) => new Date(b.attendanceDate).getTime() - new Date(a.attendanceDate).getTime(),
    );
  };

  // Cached per filter combination — revisiting a filter shows its last
  // result instantly while the fresh list loads in the background.
  const recordsCache = useCachedData<AttendanceRecord[]>(
    `attendance-records:${departmentFilter}:${statusFilter}:${recordTypeFilter}:${dateFrom}:${dateTo}`,
    fetchRecords,
  );
  const records = recordsCache.data ?? [];
  const loadRecords = () => {
    recordsCache.refresh().catch(() => undefined);
  };

  // Arrived here from a clicked attendance notification — open that attempt
  // at once. It's fetched on its own (GET /attendance/logs/:id/review) rather
  // than looked up in the list, so it opens even if it arrived after the list
  // loaded or the current filters hide it: as a flagged attempt still to be
  // reviewed, as a read-only one already rejected, or as the attendance
  // record it became part of once validated. The list is refreshed too, so
  // the new attempt shows there behind the modal.
  useEffect(() => {
    if (!initialFocusLogId) return;
    let cancelled = false;
    loadRecords();
    apiRequest<FocusedLog>(`/attendance/logs/${initialFocusLogId}/review`)
      .then((focused) => {
        if (cancelled) return;
        setViewRecord(focused.kind === "record" ? focused.record : flaggedLogToRecord(focused.log, focused.reviewed));
      })
      .catch((error) => {
        if (cancelled) return;
        setNotification({
          type: "error",
          title: "Couldn't Open Attendance",
          message: error instanceof Error ? error.message : "This attendance attempt could not be loaded.",
        });
      })
      .finally(() => {
        if (!cancelled) onFocusHandled?.();
      });
    return () => {
      cancelled = true;
    };
  }, [initialFocusLogId]);

  useEffect(
    () => setPage(1),
    [departmentFilter, statusFilter, recordTypeFilter, dateFrom, dateTo, searchQuery],
  );
  // Search narrows the already-loaded list client-side, so typing doesn't
  // refetch (or add a cache entry) per keystroke.
  const visibleRecords = records.filter((record) => matchesEmployeeQuery(record.employee, searchQuery));
  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / ATTENDANCE_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pagedRecords = visibleRecords.slice((pageSafe - 1) * ATTENDANCE_PAGE_SIZE, pageSafe * ATTENDANCE_PAGE_SIZE);

  const employeeOptionsCache = useCachedData<EmployeeOption[]>("employees", () =>
    apiRequest<EmployeeOption[]>("/employees"),
  );
  const employeeOptions = employeeOptionsCache.data ?? [];

  const { departmentNames: departments } = useActiveDepartments();

  const handleUpdated = (record: AttendanceRecord, title: string, message: string) => {
    recordsCache.setData(records.map((item) => (item.id === record.id ? record : item)));
    setViewRecord(null);
    setNotification({ type: "success", title, message });
  };

  const handleFlaggedResolved = (title: string, message: string) => {
    setViewRecord(null);
    setNotification({ type: "success", title, message });
    loadRecords();
  };

  return (
    <>
      <NotificationModal notification={notification} onClose={() => setNotification(null)} />

      <div className="attendance-filter-bar">
        <div className="attendance-filter-group employee-search-group">
          <label className="attendance-filter-label">Search</label>
          <EmployeeSearchSelect
            value={searchQuery}
            onChange={setSearchQuery}
            options={employeeOptions.filter(
              (employee) => departmentFilter === "ALL" || employee.department.name === departmentFilter,
            )}
          />
        </div>

        {!isDepartmentLocked && (
          <div className="attendance-filter-group">
            <label className="attendance-filter-label">Department</label>
            <DropdownFilter
              className="attendance-filter"
              value={departmentFilter}
              onChange={setDepartmentFilter}
              options={departments.map((department) => ({ value: department, label: department }))}
              allLabel="All Departments"
              menuLabel="Filter by department"
              ariaLabel="Department"
            />
          </div>
        )}

        <div className="attendance-filter-group">
          <label className="attendance-filter-label">Status</label>
          <DropdownFilter
            className="attendance-filter"
            value={statusFilter}
            onChange={setStatusFilter}
            options={statusOptions.map((status) => ({ value: status, label: getStatusLabel(status) }))}
            allLabel="All Status"
            menuLabel="Filter by status"
            ariaLabel="Status"
          />
        </div>

        <div className="attendance-filter-group">
          <label className="attendance-filter-label">Type</label>
          <DropdownFilter
            className="attendance-filter"
            value={recordTypeFilter}
            onChange={setRecordTypeFilter}
            options={recordTypeOptions.map((recordType) => ({ value: recordType, label: getRecordTypeLabel(recordType) }))}
            allLabel="Non-field & Field"
            menuLabel="Filter by office/field"
            ariaLabel="Office or Field"
          />
        </div>

        <div className="attendance-filter-group">
          <label className="attendance-filter-label">From</label>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="History from date" />
        </div>

        <div className="attendance-filter-group">
          <label className="attendance-filter-label">To</label>
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="History to date" />
        </div>

        <div className="attendance-filter-actions">
          <button
            className="attendance-clear-button"
            onClick={() => { setDepartmentFilter("ALL"); setStatusFilter("ALL"); setRecordTypeFilter("ALL"); setDateFrom(""); setDateTo(""); setSearchQuery(""); }}
          >
            <X size={13} /> Clear
          </button>
          <span className="attendance-today-badge">{formatTodayLabel(now)}</span>
        </div>
      </div>

      <section className="table-card attendance-table-card">
        <div className="attendance-table-scroll">
        <table>
          <thead>
            <tr>
              <th>EMPLOYEE</th>
              <th>DEPARTMENT</th>
              <th>SITE</th>
              <th>MODE</th>
              <th>DATE</th>
              {/* Office rows are Time In/Out, field rows Start/End Visit —
                  a mixed list names both. */}
              <th>{recordTypeFilter === "FIELD" ? "START VISIT" : recordTypeFilter === "OFFICE" ? "TIME IN" : "TIME IN / START"}</th>
              <th>{recordTypeFilter === "FIELD" ? "END VISIT" : recordTypeFilter === "OFFICE" ? "TIME OUT" : "TIME OUT / END"}</th>
              <th>LUNCH / BREAK</th>
              <th>STATUS</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {visibleRecords.length === 0 ? (
              <tr><td colSpan={10} className="attendance-empty-state">No attendance records found.</td></tr>
            ) : (
              pagedRecords.map((record) => (
                <tr key={record.id}>
                  <td data-label="Employee">{getName(record)}</td>
                  <td data-label="Department">{record.employee.department.name}</td>
                  <td data-label="Site">{record.workLocation?.name ?? "—"}</td>
                  <td data-label="Mode">
                    <Badge tone="neutral">{getRecordTypeLabel(record.recordType ?? "OFFICE")}</Badge>
                  </td>
                  <td data-label="Date">{formatDate(record.attendanceDate)}</td>
                  <td data-label={record.recordType === "FIELD" ? "Start Visit" : "Time In"}>{formatTime(record.timeInAt, record.status)}</td>
                  <td data-label={record.recordType === "FIELD" ? "End Visit" : "Time Out"}>{formatTime(record.timeOutAt, record.status)}</td>
                  <td data-label={record.breakKind === "BREAK" ? "Break" : "Lunch Break"}>
                    {record.lunchOutAt ? `${record.breakKind === "BREAK" ? "Break " : ""}${formatTime(record.lunchOutAt)} – ${formatTime(record.lunchInAt)}` : "—"}
                  </td>
                  <td data-label="Status"><Badge tone={getStatusTone(record.status)}>{getStatusLabel(record.status)}</Badge></td>
                  <td data-label="Action">
                    <button className="attendance-view-button" onClick={() => setViewRecord(record)}>
                      <Eye size={14} /> View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
        {pageCount > 1 && (
          <div className="attendance-pagination">
            <button type="button" className="outline-button" disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>
              Previous
            </button>
            <span>Page {pageSafe} of {pageCount}</span>
            <button type="button" className="outline-button" disabled={pageSafe >= pageCount} onClick={() => setPage(pageSafe + 1)}>
              Next
            </button>
          </div>
        )}
      </section>

      {viewRecord && (
        <AttendanceDetailsModal
          record={viewRecord}
          onClose={() => setViewRecord(null)}
          onUpdated={handleUpdated}
          onFlaggedResolved={handleFlaggedResolved}
          canWrite={canWrite}
        />
      )}
    </>
  );
}
