// pages/leave/LeavePage.tsx
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, FileText, Paperclip, Plus, Search, X } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";
import "./LeavePage.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type LeaveType = {
  id: string;
  name: string;
  defaultDays: string;
  requiresDocument: boolean;
};

type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  reason: string;
  adminRemarks?: { remarks?: string } | null;
  attachmentName?: string | null;
  attachmentMimeType?: string | null;
  attachmentData?: string | null;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    department?: { name: string };
  };
  leaveType: { id: string; name: string };
};

type LeaveBalance = {
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  earnedDays: number;
  usedDays: number;
  remainingDays: number;
};

type Notification = { type: "success" | "error"; message: string } | null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Component ───────────────────────────────────────────────────────────────

export function LeavePage() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [requests, setRequests]             = useState<LeaveRequest[]>([]);
  const [leaveTypes, setLeaveTypes]         = useState<LeaveType[]>([]);
  const [statusFilter, setStatusFilter]     = useState("ALL");
  const [typeFilter, setTypeFilter]         = useState("ALL");
  const [searchTerm, setSearchTerm]         = useState("");
  const [reviewRequest, setReviewRequest]   = useState<LeaveRequest | null>(null);
  const [remarks, setRemarks]               = useState("");
  const [isSaving, setIsSaving]             = useState(false);
  const [notification, setNotification]     = useState<Notification>(null);
  const [reviewBalances, setReviewBalances] = useState<LeaveBalance[] | null>(null);

  // Add Leave Type modal state
  const [showAddType, setShowAddType]   = useState(false);
  const [newTypeName, setNewTypeName]   = useState("");
  const [newTypeDays, setNewTypeDays]   = useState("15");
  const [newTypeDoc, setNewTypeDoc]     = useState(false);
  const [isAddingType, setIsAddingType] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const loadRequests = () => {
    apiRequest<LeaveRequest[]>("/leave-requests")
      .then(setRequests)
      .catch(() => undefined);
  };

  const loadLeaveTypes = () => {
    apiRequest<LeaveType[]>("/leave-types")
      .then(setLeaveTypes)
      .catch(() => undefined);
  };

  useEffect(loadRequests, []);
  useEffect(loadLeaveTypes, []);

  // Auto-dismiss notification after 3.5 s
  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 3500);
    return () => window.clearTimeout(id);
  }, [notification]);

  // Fetch the reviewed employee's leave balances whenever the review modal opens
  useEffect(() => {
    if (!reviewRequest) {
      setReviewBalances(null);
      return;
    }
    const year = new Date(reviewRequest.startDate).getFullYear();
    apiRequest<LeaveBalance[]>(
      `/leave-balances/${reviewRequest.employee.id}?year=${year}`
    )
      .then(setReviewBalances)
      .catch(() => setReviewBalances(null));
  }, [reviewRequest]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const statusCounts = useMemo(() => {
    const counts = { ALL: requests.length, PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const r of requests) {
      if (r.status === "PENDING") counts.PENDING += 1;
      else if (r.status === "APPROVED" || r.status === "SUPERVISOR_APPROVED") counts.APPROVED += 1;
      else if (r.status === "REJECTED") counts.REJECTED += 1;
    }
    return counts;
  }, [requests]);

  const visibleRequests = useMemo(
    () =>
      requests.filter((r) => {
        const matchesStatus =
          statusFilter === "ALL" || r.status === statusFilter;
        const matchesType =
          typeFilter === "ALL" || r.leaveType.id === typeFilter;
        const matchesSearch =
          !searchTerm.trim() ||
          getEmployeeName(r)
            .toLowerCase()
            .includes(searchTerm.trim().toLowerCase());
        return matchesStatus && matchesType && matchesSearch;
      }),
    [requests, statusFilter, typeFilter, searchTerm]
  );

  const selectedLeaveType = reviewRequest
    ? leaveTypes.find((t) => t.id === reviewRequest.leaveType.id)
    : undefined;

  const matchingBalance =
    reviewRequest && reviewBalances
      ? reviewBalances.find((b) => b.leaveTypeId === reviewRequest.leaveType.id)
      : undefined;

  const wouldExceedBalance = Boolean(
    matchingBalance &&
      reviewRequest &&
      reviewRequest.status !== "APPROVED" &&
      Number(reviewRequest.totalDays) > matchingBalance.remainingDays
  );

  // ── Actions ────────────────────────────────────────────────────────────────

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
      setNotification({
        type: "success",
        message: `Leave request was ${action === "approve" ? "approved" : "rejected"}.`,
      });
      loadRequests();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to review leave.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const addLeaveType = async () => {
    const name = newTypeName.trim();
    if (!name || !newTypeDays) return;
    setIsAddingType(true);
    try {
      await apiRequest("/leave-types", {
        method: "POST",
        body: JSON.stringify({
          name,
          defaultDays: Number(newTypeDays),
          requiresDocument: newTypeDoc,
        }),
      });
      setShowAddType(false);
      setNewTypeName("");
      setNewTypeDays("15");
      setNewTypeDoc(false);
      setNotification({ type: "success", message: `"${name}" leave type added.` });
      loadLeaveTypes();
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to add leave type.",
      });
    } finally {
      setIsAddingType(false);
    }
  };

  const closeAddTypeModal = () => {
    setShowAddType(false);
    setNewTypeName("");
    setNewTypeDays("15");
    setNewTypeDoc(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Toast notification ── */}
      {notification && (
        <div className={`leave-notification ${notification.type}`} role="status">
          {notification.type === "success"
            ? <CheckCircle2 size={17} />
            : <AlertTriangle size={17} />}
          <span>{notification.message}</span>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="leave-toolbar">
        <div className="filter-tabs">
          {(["ALL", "PENDING", "APPROVED", "REJECTED"] as const).map((tab) => (
            <button
              key={tab}
              className={statusFilter === tab ? "active" : ""}
              onClick={() => setStatusFilter(tab)}
            >
              {tab === "ALL" ? "All Leave" : tab.charAt(0) + tab.slice(1).toLowerCase()}
              {" "}({statusCounts[tab]})
            </button>
          ))}
        </div>

        <div className="leave-toolbar-secondary">
          {/* Search */}
          <div className="leave-search">
            <Search size={14} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search employee..."
              aria-label="Search by employee name"
            />
          </div>

          {/* Leave type filter + add button */}
          <div className="leave-type-filter-row">
            <select
              className="leave-select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              aria-label="Filter by leave type"
            >
              <option value="ALL">All Leave Types</option>
              {leaveTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <button
              className="add-leave-type-btn"
              onClick={() => setShowAddType(true)}
              aria-label="Add leave type"
              title="Add leave type"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <section className="table-card leave-table-card">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Leave Type</th>
              <th>Dates</th>
              <th>Days</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleRequests.length === 0 ? (
              <tr>
                <td colSpan={7} className="leave-empty-state">
                  {requests.length === 0
                    ? "No leave requests found."
                    : "No leave requests match your current filters."}
                </td>
              </tr>
            ) : (
              visibleRequests.map((r) => (
                <tr key={r.id}>
                  <td data-label="Employee">{getEmployeeName(r)}</td>
                  <td data-label="Department">{r.employee.department?.name ?? "Unassigned"}</td>
                  <td data-label="Leave Type">{r.leaveType.name}</td>
                  <td data-label="Dates">
                    {formatDate(r.startDate)} – {formatDate(r.endDate)}
                  </td>
                  <td data-label="Days">{r.totalDays}</td>
                  <td data-label="Status">
                    <Badge tone={getLeaveTone(r.status)}>{r.status}</Badge>
                  </td>
                  <td data-label="Action">
                    <button
                      className="leave-view-button"
                      onClick={() => { setReviewRequest(r); setRemarks(""); }}
                    >
                      <Eye size={14} /> Review
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* ── Review modal ── */}
      {reviewRequest && (
        <div className="leave-modal-backdrop" role="presentation">
          <section
            className="leave-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-review-title"
          >
            <div className="leave-modal-header">
              <div>
                <h2 id="leave-review-title">Leave Request Details</h2>
                <p>{getEmployeeName(reviewRequest)}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setReviewRequest(null)}
                aria-label="Close leave review"
              >
                <X size={18} />
              </button>
            </div>

            <div className="leave-detail-grid">
              <div><span>Employee</span><strong>{getEmployeeName(reviewRequest)}</strong></div>
              <div><span>Department</span><strong>{reviewRequest.employee.department?.name ?? "Unassigned"}</strong></div>
              <div><span>Leave Type</span><strong>{reviewRequest.leaveType.name}</strong></div>
              <div>
                <span>Date Range</span>
                <strong>{formatDate(reviewRequest.startDate)} – {formatDate(reviewRequest.endDate)}</strong>
              </div>
              <div><span>Total Days</span><strong>{reviewRequest.totalDays}</strong></div>
              <div>
                <span>Status</span>
                <Badge tone={getLeaveTone(reviewRequest.status)}>{reviewRequest.status}</Badge>
              </div>

              {matchingBalance && (
                <div>
                  <span>Leave Balance ({matchingBalance.year})</span>
                  <strong className={wouldExceedBalance ? "leave-balance-warning" : ""}>
                    {matchingBalance.remainingDays} of {matchingBalance.earnedDays} days remaining
                  </strong>
                </div>
              )}

              {wouldExceedBalance && (
                <div className="leave-balance-alert">
                  <AlertTriangle size={14} />
                  <span>This request exceeds the employee's remaining balance for this leave type.</span>
                </div>
              )}

              {selectedLeaveType?.requiresDocument && (
                <div>
                  <span>Document Required</span>
                  <strong className="leave-requires-doc">Yes, per policy</strong>
                </div>
              )}

              <div className="leave-attachment-row">
                <span>Supporting Document</span>
                {reviewRequest.attachmentData ? (
                  reviewRequest.attachmentMimeType?.startsWith("image/") ? (
                    <a
                      className="leave-attachment-preview"
                      href={`data:${reviewRequest.attachmentMimeType};base64,${reviewRequest.attachmentData}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={`data:${reviewRequest.attachmentMimeType};base64,${reviewRequest.attachmentData}`}
                        alt={reviewRequest.attachmentName ?? "Supporting document"}
                      />
                      <span><Paperclip size={13} /> {reviewRequest.attachmentName ?? "View attachment"}</span>
                    </a>
                  ) : (
                    <a
                      className="leave-attachment-link"
                      href={`data:${reviewRequest.attachmentMimeType ?? "application/octet-stream"};base64,${reviewRequest.attachmentData}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <FileText size={14} /> {reviewRequest.attachmentName ?? "View document"}
                    </a>
                  )
                ) : (
                  <strong className="leave-no-attachment">None attached</strong>
                )}
              </div>

              <div><span>Reason</span><strong>{reviewRequest.reason}</strong></div>
              <div><span>Latest Remarks</span><strong>{reviewRequest.adminRemarks?.remarks ?? "None"}</strong></div>
            </div>

            {reviewRequest.status !== "REJECTED" && (
              <label className="leave-remarks-field">
                Add Remarks
                <textarea
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Optional review notes"
                />
              </label>
            )}

            <div className="leave-detail-actions">
              {reviewRequest.status !== "REJECTED" && (
                <>
                  <button className="leave-reject-button" onClick={() => reviewLeave("reject")} disabled={isSaving}>
                    Reject
                  </button>
                  <button className="primary-button" onClick={() => reviewLeave("approve")} disabled={isSaving}>
                    Approve
                  </button>
                </>
              )}
              <button className="outline-button" onClick={() => setReviewRequest(null)} disabled={isSaving}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add Leave Type modal ── */}
      {showAddType && (
        <div className="leave-modal-backdrop" role="presentation">
          <section
            className="leave-modal leave-modal--sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-type-title"
          >
            <div className="leave-modal-header">
              <div>
                <h2 id="add-type-title">Add Leave Type</h2>
                <p>New type will appear in the filter immediately</p>
              </div>
              <button
                className="icon-button"
                onClick={closeAddTypeModal}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="add-type-body">
              <label className="add-type-field">
                <span className="add-type-label">
                  Leave Type Name <span className="add-type-required">*</span>
                </span>
                <input
                  className="add-type-input"
                  type="text"
                  value={newTypeName}
                  onChange={(e) => setNewTypeName(e.target.value)}
                  placeholder="e.g. Emergency Leave"
                  autoFocus
                />
              </label>

              <label className="add-type-field">
                <span className="add-type-label">
                  Default Days per Year <span className="add-type-required">*</span>
                </span>
                <input
                  className="add-type-input"
                  type="number"
                  min={1}
                  value={newTypeDays}
                  onChange={(e) => setNewTypeDays(e.target.value)}
                />
              </label>

              <label className="add-type-checkbox">
                <input
                  type="checkbox"
                  checked={newTypeDoc}
                  onChange={(e) => setNewTypeDoc(e.target.checked)}
                />
                <span>Requires supporting document</span>
              </label>
            </div>

            <div className="leave-detail-actions">
              <button
                className="primary-button"
                onClick={addLeaveType}
                disabled={isAddingType || !newTypeName.trim() || !newTypeDays}
              >
                {isAddingType ? "Saving…" : "Add Leave Type"}
              </button>
              <button
                className="outline-button"
                onClick={closeAddTypeModal}
                disabled={isAddingType}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}