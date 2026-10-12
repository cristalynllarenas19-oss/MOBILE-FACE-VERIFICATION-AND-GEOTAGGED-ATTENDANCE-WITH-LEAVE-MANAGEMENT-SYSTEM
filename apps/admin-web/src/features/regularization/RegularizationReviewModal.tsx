import { useEffect, useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";
import { revalidateCached } from "../../lib/dataCache";
import { formatEmploymentStatus } from "../../types/employment";
import "./RegularizationReviewModal.css";

// Shape of GET /evaluations/employee/:id/review.
type RegularizationReview = {
  viewerRole: "ADMIN" | "SUPERVISOR";
  employee: {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    email: string | null;
    department: string | null;
    position: string | null;
    employeeType: string | null;
    supervisorName: string | null;
    hireDate: string;
    employmentStatus: string;
  };
  // Null once the employee is no longer on probation — nothing left to decide.
  targetStatus: string | null;
  attendance: {
    totalWorkingDays: number;
    daysPresent: number;
    absences: number;
    lateOccurrences: number;
    undertimeOccurrences: number;
  };
  recommendation: {
    decision: "APPROVE" | "REJECT";
    remarks: string | null;
    decidedAt: string | null;
    supervisorName: string;
  } | null;
};

function formatLongDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatTenure(hireDate: string) {
  const start = new Date(hireDate);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) return "";
  const anchor = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
  const days = Math.max(0, Math.round((now.getTime() - anchor.getTime()) / 86_400_000));
  return `${months} month${months === 1 ? "" : "s"}, ${days} day${days === 1 ? "" : "s"}`;
}

// Opened from the probation notifications. The Supervisor's Approve / Reject
// is a recommendation sent to Admin; only the Admin's Approve converts the
// employee, and the Admin's Reject leaves them on probation.
export function RegularizationReviewModal({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const [review, setReview] = useState<RegularizationReview | null>(null);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  // Set once this viewer has decided — replaces the buttons with the outcome.
  const [outcome, setOutcome] = useState("");

  const loadReview = () =>
    apiRequest<RegularizationReview>(`/evaluations/employee/${employeeId}/review`)
      .then(setReview)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load this employee's record."));

  useEffect(() => {
    loadReview();
  }, [employeeId]);

  const decide = async (decision: "APPROVE" | "REJECT") => {
    if (!review) return;
    setIsSaving(true);
    setError("");
    const body = JSON.stringify({ remarks: remarks.trim() || undefined });
    try {
      if (review.viewerRole === "SUPERVISOR") {
        await apiRequest(`/evaluations/employee/${employeeId}/recommend`, {
          method: "POST",
          body: JSON.stringify({ decision, remarks: remarks.trim() || undefined }),
        });
        setOutcome(
          decision === "APPROVE"
            ? "Your recommendation to approve was sent to the admin."
            : "Your recommendation to reject was sent to the admin.",
        );
      } else if (decision === "APPROVE") {
        await apiRequest(`/employees/${employeeId}`, {
          method: "PATCH",
          body: JSON.stringify({ employmentStatus: review.targetStatus }),
        });
        // Employee Management reads the same cached list — refresh it so the
        // new status shows there without a reload.
        revalidateCached("employees", () => apiRequest("/employees")).catch(() => undefined);
        setOutcome(`Approved. The employee is now ${formatEmploymentStatus(review.targetStatus ?? undefined)}.`);
      } else {
        await apiRequest(`/evaluations/employee/${employeeId}/reject`, { method: "POST", body });
        setOutcome("Rejected. The employee remains on probation.");
      }
      await loadReview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save your decision.");
    } finally {
      setIsSaving(false);
    }
  };

  const employee = review?.employee;
  const recommendation = review?.recommendation;
  const canDecide =
    !!review &&
    !outcome &&
    !!review.targetStatus &&
    (review.viewerRole === "ADMIN" || !review.recommendation);

  return (
    <div className="regularization-review-backdrop" role="presentation">
      <section
        className="regularization-review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="regularization-review-title"
      >
        <div className="regularization-review-header">
          <div>
            <h2 id="regularization-review-title">Regularization Review</h2>
            <p>{employee ? `${employee.firstName} ${employee.lastName}` : "Loading…"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={isSaving} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="regularization-review-body">
          {!review && !error && <p className="regularization-review-note">Loading employee record…</p>}

          {review && employee && (
            <>
              <div className="regularization-review-section">Employee Record</div>
              <div className="regularization-review-rows">
                <div><span>Employee No.</span><strong>{employee.employeeNo}</strong></div>
                <div><span>Email</span><strong>{employee.email ?? "—"}</strong></div>
                <div><span>Department</span><strong>{employee.department ?? "—"}</strong></div>
                <div><span>Position</span><strong>{employee.position ?? "—"}</strong></div>
                <div><span>Employee Type</span><strong>{employee.employeeType ?? "—"}</strong></div>
                <div><span>Supervisor</span><strong>{employee.supervisorName ?? "Unassigned"}</strong></div>
                <div>
                  <span>Status</span>
                  <Badge tone={review.targetStatus ? "warning" : "success"}>
                    {formatEmploymentStatus(employee.employmentStatus)}
                  </Badge>
                </div>
                <div><span>Hire Date</span><strong>{formatLongDate(employee.hireDate)}</strong></div>
                <div><span>Length of Service</span><strong>{formatTenure(employee.hireDate) || "—"}</strong></div>
              </div>

              <div className="regularization-review-section">Attendance Since Hire</div>
              <div className="regularization-review-stats">
                <div><strong>{review.attendance.totalWorkingDays}</strong><span>Working days</span></div>
                <div><strong>{review.attendance.daysPresent}</strong><span>Present</span></div>
                <div><strong>{review.attendance.absences}</strong><span>Absent</span></div>
                <div><strong>{review.attendance.lateOccurrences}</strong><span>Late</span></div>
                <div><strong>{review.attendance.undertimeOccurrences}</strong><span>Undertime</span></div>
              </div>

              <div className="regularization-review-section">Supervisor Recommendation</div>
              {recommendation ? (
                <div className="regularization-review-rows">
                  <div>
                    <span>Recommendation</span>
                    <Badge tone={recommendation.decision === "APPROVE" ? "success" : "danger"}>
                      {recommendation.decision === "APPROVE" ? "Approve" : "Reject"}
                    </Badge>
                  </div>
                  <div><span>By</span><strong>{recommendation.supervisorName}</strong></div>
                  {recommendation.decidedAt && (
                    <div><span>Date</span><strong>{formatLongDate(recommendation.decidedAt)}</strong></div>
                  )}
                  <div><span>Remarks</span><strong>{recommendation.remarks || "None"}</strong></div>
                </div>
              ) : (
                <p className="regularization-review-note">No recommendation from the supervisor yet.</p>
              )}

              {!review.targetStatus && !outcome && (
                <p className="regularization-review-note">This employee is no longer on probation.</p>
              )}

              {canDecide && (
                <label className="regularization-review-remarks">
                  Remarks (optional)
                  <textarea
                    value={remarks}
                    onChange={(event) => setRemarks(event.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder={
                      review.viewerRole === "SUPERVISOR"
                        ? "Add a note for the admin"
                        : "Add a note about this decision"
                    }
                  />
                </label>
              )}
            </>
          )}
        </div>

        <div className="regularization-review-actions">
          {outcome && <p className="regularization-review-outcome">{outcome}</p>}
          {error && <p className="regularization-review-error">{error}</p>}
          {canDecide && review?.viewerRole === "SUPERVISOR" && (
            <p className="regularization-review-hint">Your decision is sent to the admin, who makes the final call.</p>
          )}
          <div>
            {canDecide && (
              <>
                <button
                  type="button"
                  className="outline-button outline-button--danger"
                  onClick={() => decide("REJECT")}
                  disabled={isSaving}
                >
                  <XCircle size={15} />
                  Reject
                </button>
                <button type="button" className="primary-button" onClick={() => decide("APPROVE")} disabled={isSaving}>
                  <CheckCircle2 size={15} />
                  Approve
                </button>
              </>
            )}
            <button type="button" className="outline-button" onClick={onClose} disabled={isSaving}>
              Close
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
