import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, MapPin, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";
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

function AttendanceDetailsModal({
  record,
  onClose,
  onUpdated,
}: {
  record: AttendanceRecord;
  onClose: () => void;
  onUpdated: (record: AttendanceRecord, message: string) => void;
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
          <label>
            Add Remarks
            <textarea
              value={remarks}
              onChange={(event) => setRemarks(event.target.value)}
              placeholder={record.adminRemarks?.remarks ?? "Optional review notes"}
            />
          </label>
          {error && <p className="attendance-form-error">{error}</p>}
          <div>
            <button className="outline-button" onClick={onClose} disabled={isSaving}>Close</button>
            <button className="primary-button" onClick={() => updateStatus("approve")} disabled={isSaving}>Approve</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function AttendancePage() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [dateFilter, setDateFilter] = useState("");
  const [viewRecord, setViewRecord] = useState<AttendanceRecord | null>(null);
  const [notification, setNotification] = useState<Notification>(null);

  const loadRecords = () => {
    const params = new URLSearchParams();
    if (departmentFilter !== "ALL") params.set("department", departmentFilter);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (dateFilter) params.set("date", dateFilter);
    const query = params.toString();
    apiRequest<AttendanceRecord[]>(`/attendance${query ? `?${query}` : ""}`).then(setRecords).catch(() => undefined);
  };

  useEffect(loadRecords, [departmentFilter, statusFilter, dateFilter]);

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

      <div className="attendance-toolbar">
        <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)} aria-label="Department">
          <option value="ALL">All Departments</option>
          {departments.map((department) => <option key={department} value={department}>{department}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Status">
          <option value="ALL">All Status</option>
          {statusOptions.map((status) => <option key={status} value={status}>{getStatusLabel(status)}</option>)}
        </select>
        <input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} aria-label="Date" />
        <button className="attendance-clear-button" onClick={() => { setDepartmentFilter("ALL"); setStatusFilter("ALL"); setDateFilter(""); }}>All</button>
      </div>

      <section className="table-card attendance-table-card">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Date</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr><td colSpan={7} className="attendance-empty-state">No attendance records found.</td></tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td data-label="Employee">{getName(record)}</td>
                  <td data-label="Department">{record.employee.department.name}</td>
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

      {viewRecord && <AttendanceDetailsModal record={viewRecord} onClose={() => setViewRecord(null)} onUpdated={handleUpdated} />}
    </>
  );
}
