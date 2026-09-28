import { apiRequest } from "./api";
import { revalidateCached, useCachedData } from "./dataCache";

export type PositionDepartmentScope = "ALL" | "ALL_EXCEPT" | "ONLY";

export type Position = {
  id: string;
  title: string;
  isActive: boolean;
  departmentScope: PositionDepartmentScope;
  departments: { departmentId: string; department: { id: string; name: string } }[];
  // Non-archived employees holding this position.
  _count: { employees: number };
};

const POSITIONS_CACHE_KEY = "positions";
const fetchPositions = () => apiRequest<Position[]>("/positions");

// Everything, for Utilities → Positions.
export function usePositions() {
  const cache = useCachedData<Position[]>(POSITIONS_CACHE_KEY, fetchPositions);
  return { positions: cache.data ?? [], refresh: cache.refresh, isLoading: cache.isLoading };
}

// Positions offered in one department — decided by the backend from the
// Utilities → Positions settings, never a list kept in this app.
export function useAvailablePositions(departmentId?: string | null) {
  const cache = useCachedData<{ id: string; title: string }[]>(
    departmentId ? `positions-available:${departmentId}` : null,
    () => apiRequest(`/positions/available?departmentId=${encodeURIComponent(departmentId!)}`),
  );
  return { positions: departmentId ? cache.data ?? [] : [], isLoading: Boolean(departmentId) && cache.isLoading };
}

// After any create/edit/archive/restore in Utilities → Positions. Per-
// department lists are keyed separately, so they're refetched the next time
// a department is picked (stale-while-revalidate).
export function revalidatePositions() {
  return revalidateCached(POSITIONS_CACHE_KEY, fetchPositions);
}
