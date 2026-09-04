// Mirrors the backend's Prisma `EmploymentStatus` enum (backend/prisma/schema.prisma).
// This is a fixed HR/legal classification, not admin-configurable data — unlike
// attendance modes, it isn't fetched from the API. Update here (and in the
// Prisma schema) if the set of statuses ever changes.
export type EmploymentStatus = "REGULAR" | "PROBATIONARY" | "PERMANENT_SEASONAL" | "PROBATIONARY_SEASONAL" | "SEPARATED";

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  REGULAR: "Regular Employee",
  PROBATIONARY: "Probationary Employee",
  PERMANENT_SEASONAL: "Permanent Seasonal Employee",
  PROBATIONARY_SEASONAL: "Probationary Seasonal Employee",
  SEPARATED: "Separated",
};

export const EMPLOYMENT_STATUS_OPTIONS: { value: EmploymentStatus; label: string }[] = (
  Object.keys(EMPLOYMENT_STATUS_LABELS) as EmploymentStatus[]
).map((value) => ({ value, label: EMPLOYMENT_STATUS_LABELS[value] }));

// SEPARATED is only ever set via the Archive flow, never picked directly —
// use these wherever a form/filter should offer just the "active" statuses.
export const SELECTABLE_EMPLOYMENT_STATUSES: EmploymentStatus[] = EMPLOYMENT_STATUS_OPTIONS.filter(
  (option) => option.value !== "SEPARATED",
).map((option) => option.value);

export const SELECTABLE_EMPLOYMENT_STATUS_OPTIONS = EMPLOYMENT_STATUS_OPTIONS.filter(
  (option) => option.value !== "SEPARATED",
);

export function formatEmploymentStatus(status?: string | null) {
  if (!status) return "Unspecified";
  return EMPLOYMENT_STATUS_LABELS[status as EmploymentStatus] ?? status;
}
