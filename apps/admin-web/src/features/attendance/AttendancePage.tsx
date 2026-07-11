import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, MapPin, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import { PermissionCode, permissions } from "../../types/rbac";
import "./AttendancePage.css";

type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "ON_LEAVE" | "OFFICIAL_BUSINESS" | "PENDING_REVIEW";

type PhotoLogType = "TIME_IN" | "TIME_OUT" | "LUNCH_OUT" | "LUNCH_IN";

type AttendanceLog = {
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
  status: AttendanceStatus;
  visitNumber?: number;
  workLocation?: { name: string } | null;
  employee: {
    employeeNo?: string;
    firstName: string;
    lastName: string;
    department: { name: string };
    position?: { title: string } | null;
    faceProfiles?: { referenceImageData?: string | null }[];
  };
  logs: AttendanceLog[];
  adminRemarks?: { remarks?: string } | null;
  isSynthetic?: boolean;
  leaveTypeName?: string;
};

type EmployeeOption = {
  department: { name: string };
};

type Notification = { type: "success" | "error"; message: string } | null;

const statusOptions = ["PRESENT", "LATE", "ABSENT", "ON_LEAVE", "OFFICIAL_BUSINESS", "PENDING_REVIEW"];

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Pending";
}

function getName(record: AttendanceRecord) {
  return `${record.employee.firstName} ${record.employee.lastName}`;
}

function getStatusTone(status: AttendanceStatus) {
  if (status === "PRESENT") return "success";
  if (status === "ABSENT") return "danger";
  return "warning";
}

function getStatusLabel(status: string) {
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

function photoTabLabel(tab: PhotoLogType) {
  if (tab === "TIME_IN") return "Time In";
  if (tab === "TIME_OUT") return "Time Out";
  if (tab === "LUNCH_OUT") return "Lunch Out";
  return "Lunch In";
}

function photoUri(log?: AttendanceLog | null) {
  if (!log?.faceImageData) return null;
  return `data:${log.faceImageMimeType ?? "image/jpeg"};base64,${log.faceImageData}`;
}

function AttendanceDetailsModal({
  record,
  onClose,
  onUpdated,
  canWrite,
}: {
  record: AttendanceRecord;
  onClose: () => void;
  onUpdated: (record: AttendanceRecord, message: string) => void;
  canWrite: boolean;
}) {
  const [remarks, setRemarks] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [isFacePreviewOpen, setIsFacePreviewOpen] = useState(false);
  const registeredFace = record.employee.faceProfiles?.[0]?.referenceImageData;

  const availablePhotoTabs = photoTabOrder.filter((tab) => record.logs.some((log) => log.logType === tab));
  const [activePhotoTab, setActivePhotoTab] = useState<PhotoLogType>(availablePhotoTabs[0] ?? "TIME_IN");
  const selectedLog = record.logs.find((log) => log.logType === activePhotoTab) ?? record.logs[0];
  const mapQuery = selectedLog ? `${selectedLog.latitude},${selectedLog.longitude}` : "";

  const updateStatus = async (action: "approve" | "official-business") => {
    setIsSaving(true);
    setError("");
    try {
      const updated = await apiRequest<AttendanceRecord>(`/attendance/${record.id}/${action}`, {
        method: "PATCH",
        body: JSON.stringify({ remarks: remarks.trim() }),
      });
      const suffix = remarks.trim() ? ` Remarks noted: ${remarks.trim()}` : "";
      onUpdated(updated, action === "approve" ? `Attendance was approved.${suffix}` : `Attendance was marked as Official Business.${suffix}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update attendance.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="attendance-modal-backdrop" role="presentation">
      <section className="attendance-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title">
        <div className="attendance-modal-header">
          <div>
            <h2 id="attendance-modal-title">Attendance Details</h2>
            <p>{formatDate(record.attendanceDate)}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close attendance details">
            <X size={18} />
          </button>
        </div>

        {record.isSynthetic ? (
          <p className="attendance-synthetic-note">
            No attendance record — this employee is marked {getStatusLabel(record.status).toLowerCase()} for this date.
          </p>
        ) : (
          <>
            <div className="attendance-detail-grid">
              <div>
                <span>Registered Face</span>
                {registeredFace ? (
                  <button type="button" className="attendance-face-thumb-button" onClick={() => setIsFacePreviewOpen(true)}>
                    <img className="attendance-face-thumb" src={registeredFace} alt="Registered face" />
                  </button>
                ) : (
                  <strong>Not stored</strong>
                )}
              </div>
            </div>

            {availablePhotoTabs.length > 0 && (
              <div className="attendance-photo-tabs">
                {availablePhotoTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`attendance-photo-tab${activePhotoTab === tab ? " active" : ""}`}
                    onClick={() => setActivePhotoTab(tab)}
                  >
                    {photoTabLabel(tab)}
                  </button>
                ))}
              </div>
            )}

            <div className="attendance-photo-frame">
              {photoUri(selectedLog) ? (
                <img className="attendance-photo-capture" src={photoUri(selectedLog) ?? undefined} alt={`${photoTabLabel(activePhotoTab)} capture`} />
              ) : (
                <div className="attendance-photo-empty">No photo captured</div>
              )}
            </div>

            <div className="attendance-detail-grid">
              <div><span>Captured At</span><strong>{selectedLog ? new Date(selectedLog.capturedAt).toLocaleString() : "No log"}</strong></div>
              <div><span>Face Match Score</span><strong>{selectedLog?.faceSimilarityScore ? `${selectedLog.faceSimilarityScore}%` : "N/A"}</strong></div>
              <div><span>Verification Status</span><strong>{selectedLog?.verificationStatus ? getStatusLabel(selectedLog.verificationStatus) : "No log"}</strong></div>
              <div><span>Failure Reason</span><strong>{selectedLog?.failureReason ?? "None"}</strong></div>
            </div>
          </>
        )}

        <div className="attendance-section-title">Employee &amp; Attendance</div>
        <div className="attendance-detail-grid attendance-modal-main-grid">
          <div><span>Employee Name</span><strong>{getName(record)}</strong></div>
          <div><span>Employee No.</span><strong>{record.employee.employeeNo ?? "—"}</strong></div>
          <div><span>Position</span><strong>{record.employee.position?.title ?? "—"}</strong></div>
          <div><span>Department</span><strong>{record.employee.department.name}</strong></div>
          <div><span>Site</span><strong>{record.workLocation?.name ?? "—"}</strong></div>
          <div><span>Date</span><strong>{formatDate(record.attendanceDate)}</strong></div>
          <div><span>Time In</span><strong>{formatTime(record.timeInAt)}</strong></div>
          <div><span>Time Out</span><strong>{formatTime(record.timeOutAt)}</strong></div>
          <div><span>Lunch Out</span><strong>{formatTime(record.lunchOutAt)}</strong></div>
          <div><span>Lunch In</span><strong>{formatTime(record.lunchInAt)}</strong></div>
          <div><span>Status</span><Badge tone={getStatusTone(record.status)}>{getStatusLabel(record.status)}</Badge></div>
          {record.status === "ON_LEAVE" && (
            <div><span>Leave Type</span><strong>{record.leaveTypeName ?? "—"}</strong></div>
          )}
        </div>

        {!record.isSynthetic && (
          <>
            <div className="attendance-section-title">Geotagging</div>
            <div className="attendance-detail-grid">
              <div><span>Latitude & Longitude</span><strong>{selectedLog ? `${selectedLog.latitude}, ${selectedLog.longitude}` : "No log"}</strong></div>
              <div><span>Distance from Site</span><strong>{selectedLog ? `${Math.round(Number(selectedLog.distanceFromSiteMeters))}m` : "No log"}</strong></div>
              <div>
                <span>Map Preview</span>
                {selectedLog ? (
                  <a className="attendance-map-link" href={`https://www.google.com/maps?q=${mapQuery}`} target="_blank" rel="noreferrer">
                    <MapPin size={14} /> Open Map
                  </a>
                ) : (
                  <strong>No log</strong>
                )}
              </div>
              <div><span>Latest Remarks</span><strong>{record.adminRemarks?.remarks ?? "None"}</strong></div>
            </div>
          </>
        )}

        <div className="attendance-admin-actions">
          {error && <p className="attendance-form-error">{error}</p>}
          <div>
            {canWrite && !record.isSynthetic && record.status !== "PRESENT" && (
              <button className="primary-button" onClick={() => updateStatus("approve")} disabled={isSaving}>Approve</button>
            )}
            <button className="outline-button" onClick={onClose} disabled={isSaving}>Close</button>
          </div>
        </div>
      </section>

      {isFacePreviewOpen && registeredFace && (
        <div className="attendance-face-preview-backdrop" role="presentation" onClick={() => setIsFacePreviewOpen(false)}>
          <button
            className="icon-button attendance-face-preview-close"
            onClick={() => setIsFacePreviewOpen(false)}
            aria-label="Close registered face preview"
          >
            <X size={18} />
          </button>
          <img className="attendance-face-preview-image" src={registeredFace} alt="Registered face" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

export type AttendanceInitialFilter = { department?: string; status?: string; date?: string };

export function AttendancePage({
  user,
  initialFilter,
}: {
  user?: { permissions: PermissionCode[]; roles?: string[]; departmentId?: string; department?: string };
  initialFilter?: AttendanceInitialFilter;
}) {
  const canWrite = user?.permissions.includes(permissions.attendanceWrite) ?? true;
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const roles = user?.roles ?? [];
  const isDepartmentLocked = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState(initialFilter?.department ?? "ALL");
  const [statusFilter, setStatusFilter] = useState(initialFilter?.status ?? "ALL");
  const [dateFrom, setDateFrom] = useState(initialFilter?.date ?? "");
  const [dateTo, setDateTo] = useState(initialFilter?.date ?? "");
  const [viewRecord, setViewRecord] = useState<AttendanceRecord | null>(null);
  const [notification, setNotification] = useState<Notification>(null);
  const now = useNow();

  const loadRecords = () => {
    const params = new URLSearchParams();
    if (departmentFilter !== "ALL") params.set("department", departmentFilter);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);

    const query = params.toString();
    apiRequest<AttendanceRecord[]>(`/attendance${query ? `?${query}` : ""}`).then(setRecords).catch(() => undefined);
  };

  useEffect(loadRecords, [departmentFilter, statusFilter, dateFrom, dateTo]);

  useEffect(() => {
    apiRequest<EmployeeOption[]>("/employees").then(setEmployeeOptions).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!notification) return;
    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  const departments = useMemo(
    () => Array.from(new Set(employeeOptions.map((employee) => employee.department.name))).sort(),
    [employeeOptions],
  );

  const handleUpdated = (record: AttendanceRecord, message: string) => {
    setRecords((current) => current.map((item) => (item.id === record.id ? record : item)));
    setViewRecord(null);
    setNotification({ type: "success", message });
  };

  return (
    <>
      {notification && (
        <div className={`attendance-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="attendance-filter-bar">
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
            onClick={() => { setDepartmentFilter("ALL"); setStatusFilter("ALL"); setDateFrom(""); setDateTo(""); }}
          >
            <X size={13} /> Clear
          </button>
          <span className="attendance-today-badge">{formatTodayLabel(now)}</span>
        </div>
      </div>

      <section className="table-card attendance-table-card">
        <table>
          <thead>
            <tr>
              <th>EMPLOYEE</th>
              <th>DEPARTMENT</th>
              <th>SITE</th>
              <th>DATE</th>
              <th>TIME IN</th>
              <th>TIME OUT</th>
              <th>LUNCH BREAK</th>
              <th>STATUS</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr><td colSpan={9} className="attendance-empty-state">No attendance records found.</td></tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td data-label="Employee">{getName(record)}</td>
                  <td data-label="Department">{record.employee.department.name}</td>
                  <td data-label="Site">{record.workLocation?.name ?? "—"}</td>
                  <td data-label="Date">{formatDate(record.attendanceDate)}</td>
                  <td data-label="Time In">{formatTime(record.timeInAt)}</td>
                  <td data-label="Time Out">{formatTime(record.timeOutAt)}</td>
                  <td data-label="Lunch Break">
                    {record.lunchOutAt ? `${formatTime(record.lunchOutAt)} – ${formatTime(record.lunchInAt)}` : "—"}
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
      </section>

      {viewRecord && (
        <AttendanceDetailsModal
          record={viewRecord}
          onClose={() => setViewRecord(null)}
          onUpdated={handleUpdated}
          canWrite={canWrite}
        />
      )}
    </>
  );
}