import { useCallback, useMemo } from "react";
import { apiRequest } from "./api";
import { revalidateCached, useCachedData } from "./dataCache";
import type { EmploymentStatus } from "../types/employment";

export type EmployeeType = {
  id: string;
  name: string;
  description?: string | null;
  // The existing Employment Status its employees get (set server-side).
  employmentStatus: EmploymentStatus;
  isActive: boolean;
  createdAt: string;
  archivedAt?: string | null;
  // Non-archived employees currently assigned.
  _count: { employees: number };
};

const EMPLOYEE_TYPES_CACHE_KEY = "employee-types";

const fetchEmployeeTypes = () => apiRequest<EmployeeType[]>("/employee-types?includeArchived=true");

// Single source of truth for every Employee Type dropdown, filter, and label
// in the app — all of it comes from Utilities → Employee Types (GET
// /employee-types), never a hardcoded list. Fetches archived types too so an
// employee still assigned to one keeps showing its name; `active` is what
// any picker for a new assignment/filter should offer.
export function useEmployeeTypes() {
  const cache = useCachedData<EmployeeType[]>(EMPLOYEE_TYPES_CACHE_KEY, fetchEmployeeTypes);
  const all = cache.data ?? [];

  const active = useMemo(() => all.filter((type) => type.isActive), [all]);
  const options = useMemo(() => active.map((type) => ({ value: type.id, label: type.name })), [active]);
  const byId = useMemo(() => new Map(all.map((type) => [type.id, type])), [all]);

  const nameOf = useCallback(
    (employee?: { employeeTypeId?: string | null; employeeType?: { name: string } | null } | null) => {
      if (!employee) return "Unspecified";
      if (employee.employeeType?.name) return employee.employeeType.name;
      return (employee.employeeTypeId && byId.get(employee.employeeTypeId)?.name) || "Unspecified";
    },
    [byId],
  );

  return { all, active, options, byId, nameOf, isLoading: cache.isLoading, refresh: cache.refresh };
}

// Call after any create/edit/archive/restore so every mounted dropdown and
// filter picks the change up immediately.
export function revalidateEmployeeTypes() {
  return revalidateCached(EMPLOYEE_TYPES_CACHE_KEY, fetchEmployeeTypes);
}
