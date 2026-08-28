import { apiRequest } from "./api";

// Mirrors employee-mobile/src/api.ts's evaluation section 1:1 — same backend
// (backend/src/modules/evaluations), same DTO shapes.

export type EvaluationRecommendation = "READY_FOR_CONVERSION" | "NOT_YET_READY" | "NOT_RECOMMENDED";

export type ProbationaryEvaluation = {
  id: string;
  employeeId: string;
  supervisorId: string;
  workQuality: number | null;
  productivity: number | null;
  jobKnowledge: number | null;
  workAttitude: number | null;
  communication: number | null;
  teamwork: number | null;
  adaptability: number | null;
  overallRating: number | null;
  comments: string | null;
  recommendation: EvaluationRecommendation | null;
  status: "DRAFT" | "SUBMITTED";
  submittedAt: string | null;
};

export type EvaluationCriteriaInput = {
  workQuality?: number;
  productivity?: number;
  jobKnowledge?: number;
  workAttitude?: number;
  communication?: number;
  teamwork?: number;
  adaptability?: number;
  overallRating?: number;
  comments?: string;
  recommendation?: EvaluationRecommendation;
};

// Null when this Supervisor has never started an evaluation for this
// employee yet — the form starts blank in that case.
export function getEmployeeEvaluation(employeeId: string) {
  return apiRequest<ProbationaryEvaluation | null>(`/evaluations/employee/${employeeId}`);
}

export type SubmittedEvaluation = ProbationaryEvaluation & {
  supervisor: { firstName: string; lastName: string; department: { name: string } };
};

export type AttendanceSummary = {
  totalWorkingDays: number;
  daysPresent: number;
  absences: number;
  lateOccurrences: number;
  undertimeOccurrences: number;
  leaveDaysUsed: number;
  attendanceRating: number;
  attendanceRatingLabel: string;
};

// Admin-only, read-only — the most recent SUBMITTED evaluation for this
// employee (never a Supervisor's in-progress draft, null if none exists yet)
// plus an auto-generated attendance/punctuality summary over their tenure.
export function getEmployeeEvaluationForAdmin(employeeId: string) {
  return apiRequest<{ evaluation: SubmittedEvaluation | null; attendance: AttendanceSummary }>(
    `/evaluations/employee/${employeeId}/admin-view`,
  );
}

export function saveEvaluationDraft(employeeId: string, input: EvaluationCriteriaInput) {
  return apiRequest<ProbationaryEvaluation>(`/evaluations/employee/${employeeId}/draft`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function submitEvaluation(
  employeeId: string,
  input: Required<Omit<EvaluationCriteriaInput, "comments">> & { comments?: string },
) {
  return apiRequest<ProbationaryEvaluation>(`/evaluations/employee/${employeeId}/submit`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
