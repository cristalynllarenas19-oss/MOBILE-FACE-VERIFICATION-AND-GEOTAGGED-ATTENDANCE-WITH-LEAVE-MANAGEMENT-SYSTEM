import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";
import "./LeavePage.css";

type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  adminRemarks?: { remarks?: string } | null;
  employee: { firstName: string; lastName: string; department?: { name: string } };
  leaveType: { name: string };
};

type Notification = { type: "success" | "error"; message: string } | null;

function getEmployeeName(request: LeaveRequest) {
  return `${request.employee.firstName} ${request.employee.lastName}`;
}

function getLeaveTone(status: string) {
  if (status === "APPROVED" || status === "SUPERVISOR_APPROVED") return "success";
  if (status === "REJECTED" || status === "CANCELLED") return "danger";
  return "warning";
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

export function LeavePage() {
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [reviewRequest, setReviewRequest] = useState<LeaveRequest | null>(null);
  const [remarks, setRemarks] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [notification, setNotification] = useState<Notification>(null);

  const loadRequests = () => {
    apiRequest<LeaveRequest[]>("/leave-requests").then(setRequests).catch(() => undefined);
  };

  useEffect(loadRequests, []);

  useEffect(() => {
    if (!notification) return;
    const timeoutId = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [notification]);

  const leaveTypes = useMemo(() => Array.from(new Set(requests.map((request) => request.leaveType.name))).sort(), [requests]);
  const visibleRequests = requests.filter((request) => {
    const matchesStatus = statusFilter === "ALL" || request.status === statusFilter;
    const matchesType = typeFilter === "ALL" || request.leaveType.name === typeFilter;
    return matchesStatus && matchesType;
  });

  const reviewLeave = async (action: "approve" | "reject") => {
    if (!reviewRequest) return;
    setIsSaving(true);
    try {
      await apiRequest(`/leave-requests/${reviewRequest.id}/${action}`, {
        method: "PATCH",
        body: JSON.stringify({ remarks: remarks.trim() }),
      });
      setReviewRequest(null);
      setRemarks("");
      setNotification({ type: "success", message: `Leave request was ${action === "approve" ? "approved" : "rejected"}.` });
      loadRequests();
    } catch (err) {
      setNotification({ type: "error", message: err instanceof Error ? err.message : "Unable to review leave." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {notification && (
        <div className={`leave-notification ${notification.type}`} role="status">
          {notification.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="leave-toolbar">
        <div className="filter-tabs">
          <button className={statusFilter === "ALL" ? "active" : ""} onClick={() => setStatusFilter("ALL")}>All Leave ({requests.length})</button>
          <button className={statusFilter === "PENDING" ? "active" : ""} onClick={() => setStatusFilter("PENDING")}>Pending</button>
          <button className={statusFilter === "APPROVED" ? "active" : ""} onClick={() => setStatusFilter("APPROVED")}>Approved</button>
          <button className={statusFilter === "REJECTED" ? "active" : ""} onClick={() => setStatusFilter("REJECTED")}>Rejected</button>
        </div>
        <select className="leave-select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
          <option value="ALL">All Leave Types</option>
          {leaveTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </div>

      <section className="table-card leave-table-card">
        <table>
          <thead>
            <tr><th>Employee</th><th>Department</th><th>Leave Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody>
            {visibleRequests.length === 0 ? (
              <tr><td colSpan={7} className="leave-empty-state">No leave requests found.</td></tr>
            ) : (
              visibleRequests.map((request) => (
                <tr key={request.id}>
                  <td data-label="Employee">{getEmployeeName(request)}</td>
                  <td data-label="Department">{request.employee.department?.name ?? "Unassigned"}</td>
                  <td data-label="Leave Type">{request.leaveType.name}</td>
                  <td data-label="Dates">{formatDate(request.startDate)} - {formatDate(request.endDate)}</td>
                  <td data-label="Days">{request.totalDays}</td>
                  <td data-label="Status"><Badge tone={getLeaveTone(request.status)}>{request.status}</Badge></td>
                  <td data-label="Action">
                    <button className="leave-view-button" onClick={() => { setReviewRequest(request); setRemarks(""); }}><Eye size={14} /> Review</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {reviewRequest && (
        <div className="leave-modal-backdrop" role="presentation">
          <section className="leave-modal" role="dialog" aria-modal="true" aria-labelledby="leave-review-title">
            <div className="leave-modal-header">
              <div>
                <h2 id="leave-review-title">Leave Request Details</h2>
                <p>{getEmployeeName(reviewRequest)}</p>
              </div>
              <button className="icon-button" onClick={() => setReviewRequest(null)} aria-label="Close leave review"><X size={18} /></button>
            </div>
            <div className="leave-detail-grid">
              <div><span>Employee</span><strong>{getEmployeeName(reviewRequest)}</strong></div>
              <div><span>Department</span><strong>{reviewRequest.employee.department?.name ?? "Unassigned"}</strong></div>
              <div><span>Leave Type</span><strong>{reviewRequest.leaveType.name}</strong></div>
              <div><span>Date Range</span><strong>{formatDate(reviewRequest.startDate)} - {formatDate(reviewRequest.endDate)}</strong></div>
              <div><span>Total Days</span><strong>{reviewRequest.totalDays}</strong></div>
              <div><span>Status</span><Badge tone={getLeaveTone(reviewRequest.status)}>{reviewRequest.status}</Badge></div>
              <div><span>Reason</span><strong>{reviewRequest.reason}</strong></div>
              <div><span>Latest Remarks</span><strong>{reviewRequest.adminRemarks?.remarks ?? "None"}</strong></div>
            </div>
            <label className="leave-remarks-field">
              Add Remarks
              <textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Optional review notes" />
            </label>
            <div className="leave-detail-actions">
              <button className="outline-button" onClick={() => setReviewRequest(null)} disabled={isSaving}>Close</button>
              <button className="leave-reject-button" onClick={() => reviewLeave("reject")} disabled={isSaving}>Reject</button>
              <button className="primary-button" onClick={() => reviewLeave("approve")} disabled={isSaving}>Approve</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
