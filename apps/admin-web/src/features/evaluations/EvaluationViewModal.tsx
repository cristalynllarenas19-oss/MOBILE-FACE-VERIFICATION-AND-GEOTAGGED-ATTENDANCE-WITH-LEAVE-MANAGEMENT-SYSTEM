import { useEffect, useState } from "react";
import {
  CalendarDays,
  CalendarOff,
  CheckCircle2,
  Clock,
  HelpCircle,
  Hourglass,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { StatCard } from "../../components/ui/StatCard";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import {
  AttendanceSummary,
  EvaluationRecommendation,
  SubmittedEvaluation,
  getEmployeeEvaluationForAdmin,
} from "../../lib/evaluations";
import "./EvaluationModal.css";

const CRITERIA: { key: keyof SubmittedEvaluation; label: string }[] = [
  { key: "workQuality", label: "Work Quality" },
  { key: "productivity", label: "Productivity" },
  { key: "jobKnowledge", label: "Job Knowledge" },
  { key: "workAttitude", label: "Work Attitude" },
  { key: "communication", label: "Communication" },
  { key: "teamwork", label: "Teamwork" },
  { key: "adaptability", label: "Adaptability" },
];

const RECOMMENDATION_LABELS: Record<EvaluationRecommendation, string> = {
  READY_FOR_CONVERSION: "Ready for Conversion to Regular",
  NOT_YET_READY: "Not Yet Ready / Extend Probationary Period",
  NOT_RECOMMENDED: "Not Recommended for Regularization",
};

const RECOMMENDATION_TONE: Record<EvaluationRecommendation, "success" | "warning" | "danger"> = {
  READY_FOR_CONVERSION: "success",
  NOT_YET_READY: "warning",
  NOT_RECOMMENDED: "danger",
};

function ratingTone(rating: number): "success" | "warning" | "danger" {
  if (rating >= 4) return "success";
  if (rating >= 3) return "warning";
  return "danger";
}

function AttendanceSection({ attendance }: { attendance: AttendanceSummary }) {
  return (
    <div>
      <p className="evaluation-section-title">Attendance &amp; Punctuality</p>
      <div className="evaluation-stat-grid">
        <StatCard label="Total Working Days" value={attendance.totalWorkingDays} icon={CalendarDays} tone="blue" />
        <StatCard label="Days Present" value={attendance.daysPresent} icon={CheckCircle2} tone="green" />
        <StatCard label="Absences" value={attendance.absences} icon={XCircle} tone="red" />
        <StatCard label="Late Occurrences" value={attendance.lateOccurrences} icon={Clock} tone="yellow" />
        <StatCard label="Undertime Occurrences" value={attendance.undertimeOccurrences} icon={Hourglass} tone="purple" />
        <StatCard label="Leave Days Used" value={attendance.leaveDaysUsed} icon={CalendarOff} tone="pink" />
      </div>
      <div className="evaluation-rating-summary">
        <span>Attendance Rating</span>
        <div className="evaluation-rating-summary-value">
          <strong>{attendance.attendanceRating.toFixed(1)} / 5</strong>
          <Badge tone={ratingTone(attendance.attendanceRating)}>{attendance.attendanceRatingLabel}</Badge>
        </div>
      </div>
      <p className="evaluation-attendance-hint">Based on attendance and punctuality records over this employee's tenure to date.</p>
    </div>
  );
}


export function EvaluationViewModal({
  employeeId,
  employeeName,
  onClose,
  onApproved,
  onRequestArchive,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
  
  onApproved: (updatedEmployee: any) => void;
  onRequestArchive: () => void;
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [evaluation, setEvaluation] = useState<SubmittedEvaluation | null>(null);
  const [attendance, setAttendance] = useState<AttendanceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getEmployeeEvaluationForAdmin(employeeId)
      .then((data) => {
        if (cancelled) return;
        setEvaluation(data.evaluation);
        setAttendance(data.attendance);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load evaluation."))
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  async function handleApprove() {
    setIsApproving(true);
    try {
      const updated = await apiRequest(`/employees/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify({ employmentStatus: "REGULAR" }),
      });
      onApproved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve regularization.");
    } finally {
      setIsApproving(false);
    }
  }

  return (
    <div className="evaluation-modal-backdrop" role="presentation">
      <section className="evaluation-modal" role="dialog" aria-modal="true" aria-labelledby="evaluation-view-title">
        <div className="evaluation-modal-header">
          <div>
            <h2 id="evaluation-view-title">Performance Evaluation</h2>
            <p>{employeeName}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close evaluation view">
            <X size={18} />
          </button>
        </div>

        {isLoading ? (
          <div className="evaluation-modal-loading">Loading…</div>
        ) : (
          <div className="evaluation-modal-body">
            {error && <p className="evaluation-form-error">{error}</p>}

            {attendance && <AttendanceSection attendance={attendance} />}

            <div className="evaluation-divider" />

            {!evaluation ? (
              <p className="evaluation-empty-note">No evaluation has been submitted for this employee yet.</p>
            ) : (
              <>
                <div className="evaluation-locked-banner">
                  <span>
                    Submitted by {evaluation.supervisor.firstName} {evaluation.supervisor.lastName},{" "}
                    {evaluation.supervisor.department.name} Supervisor
                    {evaluation.submittedAt ? ` on ${new Date(evaluation.submittedAt).toLocaleDateString()}` : ""}.
                  </span>
                </div>

                <p className="evaluation-section-title">Supervisor's Ratings</p>
                <div className="evaluation-detail-grid">
                  {CRITERIA.map((c) => (
                    <div key={c.key}>
                      <span>{c.label}</span>
                      <span className={`evaluation-rating-pill ${ratingTone(Number(evaluation[c.key]))}`}>
                        {String(evaluation[c.key])}/5
                      </span>
                    </div>
                  ))}
                  <div>
                    <span>Overall Performance Rating</span>
                    <span className={`evaluation-rating-pill ${ratingTone(evaluation.overallRating ?? 0)}`}>
                      {evaluation.overallRating}/5
                    </span>
                  </div>
                </div>

                <p className="evaluation-section-title">Supervisor's Comments</p>
                <blockquote className="evaluation-quote">
                  {evaluation.comments || "No comments provided."}
                </blockquote>

                <p className="evaluation-section-title">Supervisor Recommendation</p>
                <div className="evaluation-badge-row">
                  <Badge tone={evaluation.recommendation ? RECOMMENDATION_TONE[evaluation.recommendation] : "neutral"}>
                    {evaluation.recommendation ? RECOMMENDATION_LABELS[evaluation.recommendation] : "—"}
                  </Badge>
                </div>

                <div className="evaluation-divider" />

                <p className="evaluation-section-title">Admin Decision</p>
                <p className="evaluation-attendance-hint">
                  The Supervisor's recommendation does not automatically change this employee's status — choose
                  below, or make the change later via Edit Employee.
                </p>
                <div className="evaluation-decision-actions">
                  <button
                    type="button"
                    className="evaluation-decision-button evaluation-decision-approve"
                    onClick={() => setShowApproveConfirm(true)}
                  >
                    <CheckCircle2 size={16} />
                    Approve Regularization
                  </button>
                  <button
                    type="button"
                    className="evaluation-decision-button evaluation-decision-review"
                    onClick={onClose}
                  >
                    <HelpCircle size={16} />
                    Request Further Review
                  </button>
                  <button
                    type="button"
                    className="evaluation-decision-button evaluation-decision-reject"
                    onClick={onRequestArchive}
                  >
                    <XCircle size={16} />
                    Not Approved
                  </button>
                </div>
              </>
            )}

            <div className="evaluation-modal-actions">
              <button type="button" className="outline-button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </section>

      {showApproveConfirm && (
        <ConfirmDialog
          config={{
            title: "Approve Regularization?",
            description: `This will convert ${employeeName}'s employment status to Regular.`,
            confirmLabel: isApproving ? "Approving…" : "Approve",
            tone: "primary",
            onConfirm: handleApprove,
          }}
          onCancel={() => setShowApproveConfirm(false)}
        />
      )}
    </div>
  );
}
