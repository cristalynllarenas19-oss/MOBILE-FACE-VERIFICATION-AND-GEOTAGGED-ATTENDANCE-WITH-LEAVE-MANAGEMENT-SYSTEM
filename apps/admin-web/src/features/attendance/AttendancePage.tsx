import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, MapPin, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { apiRequest } from "../../lib/api";
import { PermissionCode, permissions } from "../../types/rbac";
import "./AttendancePage.css";

type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "ON_LEAVE" | "OFFICIAL_BUSINESS" | "PENDING_REVIEW";

type AttendanceLog = {
  latitude: string;
  longitude: string;
  distanceFromSiteMeters: string;
  faceSimilarityScore?: string | null;
  verificationStatus: string;
  capturedAt: string;
  failureReason?: string | null;
};

type AttendanceRecord = {
  id: string;
  attendanceDate: string;
  timeInAt?: string | null;
  timeOutAt?: string | null;
  status: AttendanceStatus;
  visitNumber?: number;
  workLocation?: { name: string } | null;
  employee: {
    firstName: string;
    lastName: string;
    department: { name: string };
    faceProfiles?: { referenceImagePath?: string | null }[];
  };
  logs: AttendanceLog[];
  adminRemarks?: { remarks?: string } | null;
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
  const latestLog = record.logs[0];
  const registeredFace = record.employee.faceProfiles?.[0]?.referenceImagePath;
  const mapQuery = latestLog ? `${latestLog.latitude},${latestLog.longitude}` : "";

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

        <div className="attendance-detail-grid attendance-modal-main-grid">
          <div><span>Employee Name</span><strong>{getName(record)}</strong></div>
          <div><span>Department</span><strong>{record.employee.department.name}</strong></div>
          <div><span>Site</span><strong>{record.workLocation?.name ?? "—"}</strong></div>
          <div><span>Date</span><strong>{formatDate(record.attendanceDate)}</strong></div>
          <div><span>Time In</span><strong>{formatTime(record.timeInAt)}</strong></div>
          <div><span>Time Out</span><strong>{formatTime(record.timeOutAt)}</strong></div>
          <div><span>Status</span><Badge tone={getStatusTone(record.status)}>{getStatusLabel(record.status)}</Badge></div>
        </div>

        <div className="attendance-section-title">Face Verification</div>
        <div className="attendance-detail-grid">
          <div><span>Registered Face</span>{registeredFace ? <img className="attendance-face-thumb" src={registeredFace} alt="" /> : <strong>Not stored</strong>}</div>
          <div><span>Captured Selfie</span><strong>Not stored</strong></div>
          <div><span>Face Match Score</span><strong>{latestLog?.faceSimilarityScore ? `${latestLog.faceSimilarityScore}%` : "N/A"}</strong></div>
          <div><span>Verification Status</span><strong>{latestLog?.verificationStatus ? getStatusLabel(latestLog.verificationStatus) : "No log"}</strong></div>
          <div><span>Failure Reason</span><strong>{latestLog?.failureReason ?? "None"}</strong></div>
        </div>

        <div className="attendance-section-title">Geotagging</div>
        <div className="attendance-detail-grid">
          <div><span>Latitude & Longitude</span><strong>{latestLog ? `${latestLog.latitude}, ${latestLog.longitude}` : "No log"}</strong></div>
          <div><span>Distance from Site</span><strong>{latestLog ? `${Math.round(Number(latestLog.distanceFromSiteMeters))}m` : "No log"}</strong></div>
          <div>
            <span>Map Preview</span>
            {latestLog ? (
              <a className="attendance-map-link" href={`https://www.google.com/maps?q=${mapQuery}`} target="_blank" rel="noreferrer">
                <MapPin size={14} /> Open Map
              </a>
            ) : (
              <strong>No log</strong>
            )}
          </div>
          <div><span>Latest Remarks</span><strong>{record.adminRemarks?.remarks ?? "None"}</strong></div>
        </div>

        <div className="attendance-admin-actions">
          {error && <p className="attendance-form-error">{error}</p>}
          <div>
            {canWrite && record.status !== "PRESENT" && (
              <button className="primary-button" onClick={() => updateStatus("approve")} disabled={isSaving}>Approve</button>
            )}
            <button className="outline-button" onClick={onClose} disabled={isSaving}>Close</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function AttendancePage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canWrite = user?.permissions.includes(permissions.attendanceWrite) ?? true;
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
              <th>STATUS</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr><td colSpan={8} className="attendance-empty-state">No attendance records found.</td></tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td data-label="Employee">{getName(record)}</td>
                  <td data-label="Department">{record.employee.department.name}</td>
                  <td data-label="Site">{record.workLocation?.name ?? "—"}</td>
                  <td data-label="Date">{formatDate(record.attendanceDate)}</td>
                  <td data-label="Time In">{formatTime(record.timeInAt)}</td>
                  <td data-label="Time Out">{formatTime(record.timeOutAt)}</td>
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