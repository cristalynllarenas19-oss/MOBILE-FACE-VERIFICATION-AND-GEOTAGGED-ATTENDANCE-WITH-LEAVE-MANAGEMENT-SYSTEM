import { useMemo } from "react";
import { apiRequest } from "./api";
import { useCachedData } from "./dataCache";

// The legal set of attendance mode codes is DB-driven (GET
// /departments/attendance-modes), not a compiled union — any string the API
// returns is valid. "BOTH" (and any other row flagged availableForDepartments)
// is legal at the department level even though it's excluded from the
// employee-level set (an employee is always concretely FIXED or FIELD).
export type AttendanceMode = string;

export type AttendanceModeOption = {
  code: AttendanceMode;
  label: string;
  description?: string | null;
  availableForEmployees: boolean;
  availableForDepartments: boolean;
};

// Single source of truth for attendance mode labels/options — hits GET
// /departments/attendance-modes once (shared "attendanceModes" cache key)
// instead of each page fetching and filtering its own copy.
export function useAttendanceModeOptions() {
  const cache = useCachedData<AttendanceModeOption[]>("attendanceModes", () =>
    apiRequest<AttendanceModeOption[]>("/departments/attendance-modes"),
  );
  const all = cache.data ?? [];

  const forEmployees = useMemo(() => all.filter((mode) => mode.availableForEmployees), [all]);
  const forDepartments = useMemo(() => all.filter((mode) => mode.availableForDepartments), [all]);

  return { all, forEmployees, forDepartments, isLoading: cache.isLoading };
}

// No hardcoded fallback set — options are always sourced live from
// GET /departments/attendance-modes; if that hasn't loaded yet (or the code
// is unrecognized), callers show the raw code rather than substituting
// made-up data.
export function formatAttendanceMode(code: AttendanceMode | null | undefined, options: AttendanceModeOption[]) {
  if (!code) return "—";
  return options.find((option) => option.code === code)?.label ?? code;
}
