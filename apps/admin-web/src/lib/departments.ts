import { useMemo } from "react";
import { apiRequest } from "./api";
import { useCachedData } from "./dataCache";

export type Department = {
  id: string;
  name: string;
  isActive: boolean;
  attendanceMode: string;
};

// Single source of truth for "which departments exist" across the app —
// hits GET /departments (same "departments" cache key EmployeesPage already
// uses, so this never adds an extra network call) rather than deriving the
// list from whichever employees happen to be loaded on a given page, which
// silently drops any department with zero employees assigned.
export function useActiveDepartments() {
  const cache = useCachedData<Department[]>("departments", () => apiRequest<Department[]>("/departments"));

  const departments = useMemo(
    () =>
      (cache.data ?? [])
        .filter((department) => department.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [cache.data],
  );

  const departmentNames = useMemo(() => departments.map((department) => department.name), [departments]);

  return { departments, departmentNames, isLoading: cache.isLoading };
}
