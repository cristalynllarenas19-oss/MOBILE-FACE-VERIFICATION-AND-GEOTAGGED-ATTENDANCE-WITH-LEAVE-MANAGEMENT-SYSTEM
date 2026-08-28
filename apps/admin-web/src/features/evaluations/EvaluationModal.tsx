import { useEffect, useState } from "react";
import {
  Award,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  LucideIcon,
  MessageCircle,
  Repeat,
  Smile,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { apiRequest } from "../../lib/api";
import {
  EvaluationCriteriaInput,
  EvaluationRecommendation,
  getEmployeeEvaluation,
  saveEvaluationDraft,
  submitEvaluation,
} from "../../lib/evaluations";
import "./EvaluationModal.css";

const CRITERIA: { key: keyof EvaluationCriteriaInput; label: string; icon: LucideIcon }[] = [
  { key: "workQuality", label: "Work Quality", icon: Award },
  { key: "productivity", label: "Productivity", icon: TrendingUp },
  { key: "jobKnowledge", label: "Job Knowledge", icon: BookOpen },
  { key: "workAttitude", label: "Work Attitude", icon: Smile },
  { key: "communication", label: "Communication", icon: MessageCircle },
  { key: "teamwork", label: "Teamwork", icon: Users },
  { key: "adaptability", label: "Adaptability", icon: Repeat },
];

const RECOMMENDATIONS: { key: EvaluationRecommendation; label: string }[] = [
  { key: "READY_FOR_CONVERSION", label: "Ready for Conversion to Regular" },
  { key: "NOT_YET_READY", label: "Not Yet Ready / Extend Probationary Period" },
  { key: "NOT_RECOMMENDED", label: "Not Recommended for Regularization" },
];

function RatingButtons({
  value,
  disabled,
  onChange,
  compact,
}: {
  value: number | undefined;
  disabled: boolean;
  onChange: (n: number) => void;
  // Smaller circles for inline use next to a criterion's icon+label — the
  // Overall Performance Rating field keeps the original (non-compact) size.
  compact?: boolean;
}) {
  return (
    <div className={`evaluation-rating-row ${compact ? "compact" : ""}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          className={`evaluation-rating-button ${compact ? "compact" : ""} ${value === n ? "active" : ""}`}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function isComplete(form: EvaluationCriteriaInput) {
  return (
    CRITERIA.every((c) => typeof form[c.key] === "number") &&
    typeof form.overallRating === "number" &&
    !!form.recommendation
  );
}

export function EvaluationModal({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const [isLoading, setIsLoading] = useState(true);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [form, setForm] = useState<EvaluationCriteriaInput>({});
  const [alreadySubmitted, setAlreadySubmitted] = useState<{ submittedAt: string | null } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([
      getEmployeeEvaluation(employeeId),
      // No single-employee lookup endpoint exists — the list is already
      // scoped to this Supervisor's own department/team, same source
      // TeamScreen's mobile equivalent uses.
      apiRequest<{ id: string; firstName: string; lastName: string }[]>("/employees"),
    ])
      .then(([existing, roster]) => {
        if (cancelled) return;
        const match = roster.find((e) => e.id === employeeId);
        setEmployeeName(match ? `${match.firstName} ${match.lastName}` : null);

        if (!existing) {
          setForm({});
          setAlreadySubmitted(null);
          return;
        }
        setForm({
          workQuality: existing.workQuality ?? undefined,
          productivity: existing.productivity ?? undefined,
          jobKnowledge: existing.jobKnowledge ?? undefined,
          workAttitude: existing.workAttitude ?? undefined,
          communication: existing.communication ?? undefined,
          teamwork: existing.teamwork ?? undefined,
          adaptability: existing.adaptability ?? undefined,
          overallRating: existing.overallRating ?? undefined,
          comments: existing.comments ?? undefined,
          recommendation: existing.recommendation ?? undefined,
        });
        setAlreadySubmitted(existing.status === "SUBMITTED" ? { submittedAt: existing.submittedAt } : null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load this evaluation."))
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  function setRating(key: keyof EvaluationCriteriaInput, value: number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSaveDraft() {
    setIsSaving(true);
    setError(null);
    setDraftSaved(false);
    try {
      await saveEvaluationDraft(employeeId, form);
      setDraftSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save draft.");
    } finally {
      setIsSaving(false);
    }
  }

  function handlePressSubmit() {
    if (!isComplete(form)) {
      setValidationError("Please rate every criterion, set an overall rating, and select a recommendation before submitting.");
      return;
    }
    setValidationError(null);
    setShowConfirm(true);
  }

  async function handleConfirmSubmit() {
    setIsSubmitting(true);
    setError(null);
    try {
      const submitted = await submitEvaluation(
        employeeId,
        form as Required<Omit<EvaluationCriteriaInput, "comments">> & { comments?: string },
      );
      setAlreadySubmitted({ submittedAt: submitted.submittedAt });
      setJustSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit evaluation.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLocked = !!alreadySubmitted;

  return (
    <div className="evaluation-modal-backdrop" role="presentation">
      <section className="evaluation-modal" role="dialog" aria-modal="true" aria-labelledby="evaluation-modal-title">
        <div className="evaluation-modal-header">
          <div>
            <h2 id="evaluation-modal-title">Performance Evaluation</h2>
            {employeeName && <p>{employeeName}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close evaluation modal">
            <X size={18} />
          </button>
        </div>

        {isLoading ? (
          <div className="evaluation-modal-loading">Loading…</div>
        ) : (
          <div className="evaluation-modal-body">
            {justSubmitted && (
              <div className="evaluation-success-banner" role="status">
                <CheckCircle2 size={20} />
                <span>Evaluation submitted. Admin has been notified to review it.</span>
              </div>
            )}

            {isLocked && !justSubmitted && (
              <div className="evaluation-locked-banner">
                <ClipboardList size={18} />
                <span>
                  Submitted{alreadySubmitted?.submittedAt ? ` on ${new Date(alreadySubmitted.submittedAt).toLocaleDateString()}` : ""}. This evaluation can no longer be edited.
                </span>
              </div>
            )}

            <div className="evaluation-criteria-list">
              {CRITERIA.map((criterion) => {
                const Icon = criterion.icon;
                return (
                  <div className="evaluation-criteria-row" key={criterion.key}>
                    <span className="evaluation-criteria-icon">
                      <Icon size={16} />
                    </span>
                    <span className="evaluation-criteria-label">{criterion.label}</span>
                    <RatingButtons
                      compact
                      value={form[criterion.key] as number | undefined}
                      disabled={isLocked}
                      onChange={(n) => setRating(criterion.key, n)}
                    />
                  </div>
                );
              })}
            </div>

            <div className="evaluation-divider" />

            <div className="evaluation-field">
              <span className="evaluation-field-label">Overall Performance Rating</span>
              <RatingButtons value={form.overallRating} disabled={isLocked} onChange={(n) => setRating("overallRating", n)} />
            </div>

            <div className="evaluation-field">
              <span className="evaluation-field-label">Supervisor Comments / Remarks</span>
              <textarea
                className="evaluation-textarea"
                disabled={isLocked}
                placeholder="Optional comments about this employee's performance"
                value={form.comments ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, comments: e.target.value }))}
              />
            </div>

            <div className="evaluation-field">
              <span className="evaluation-field-label">Recommendation</span>
              <div className="evaluation-recommendation-list">
                {RECOMMENDATIONS.map((option) => (
                  <label
                    key={option.key}
                    className={`evaluation-recommendation-option ${form.recommendation === option.key ? "active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="recommendation"
                      disabled={isLocked}
                      checked={form.recommendation === option.key}
                      onChange={() => setForm((f) => ({ ...f, recommendation: option.key }))}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {validationError && <p className="evaluation-form-error">{validationError}</p>}
            {error && <p className="evaluation-form-error">{error}</p>}
            {draftSaved && !error && <p className="evaluation-draft-saved">Draft saved.</p>}

            <div className="evaluation-modal-actions">
              {!isLocked ? (
                <>
                  <button type="button" className="outline-button" onClick={handleSaveDraft} disabled={isSaving || isSubmitting}>
                    {isSaving ? "Saving…" : "Save as Draft"}
                  </button>
                  <button type="button" className="primary-button" onClick={handlePressSubmit} disabled={isSaving || isSubmitting}>
                    {isSubmitting ? "Submitting…" : "Submit Evaluation"}
                  </button>
                </>
              ) : (
                <button type="button" className="outline-button" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {showConfirm && (
        <ConfirmDialog
          config={{
            title: "Submit Evaluation?",
            description:
              "Once submitted, this evaluation cannot be edited. Admin will be notified to review it and make the final regularization decision.",
            confirmLabel: "Confirm & Submit",
            tone: "primary",
            onConfirm: handleConfirmSubmit,
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
