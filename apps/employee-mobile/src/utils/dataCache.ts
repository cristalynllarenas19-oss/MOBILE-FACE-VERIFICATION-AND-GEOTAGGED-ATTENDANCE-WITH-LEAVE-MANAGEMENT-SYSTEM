import { useCallback, useEffect, useRef, useState } from "react";
import { Directory, File, Paths } from "expo-file-system";

// Stale-while-revalidate cache for read-only API data. Screens render the
// last successful response instantly (memory first, then a JSON file that
// survives app restarts) while the real request runs in the background —
// so slow internet means "briefly stale data" instead of a spinner.
//
// Only GET-style reads go through this. Writes (Time In, leave requests,
// approvals) never touch the cache and always hit the server directly.

const memory = new Map<string, unknown>();
const cacheDir = new Directory(Paths.cache, "data-cache");

export const CACHE_KEYS = {
  myProfile: "my-profile",
  notifications: "notifications",
  notificationsUnreadCount: "notifications:unread-count",
  todayAttendance: (employeeId: string) => `today-attendance:${employeeId}`,
  attendanceEligibility: (employeeId: string) => `attendance-eligibility:${employeeId}`,
  attendanceHistory: (employeeId: string) => `attendance-history:${employeeId}`,
  leaveBalances: (employeeId: string) => `leave-balances:${employeeId}`,
  leaveRequests: (employeeId: string) => `leave-requests:${employeeId}`,
  undertimeEligibility: (employeeId: string) => `undertime-eligibility:${employeeId}`,
  undertimeFilings: (employeeId: string) => `undertime-filings:${employeeId}`,
  workArea: (employeeId: string, mode: "field" | "fixed") => `work-area:${employeeId}:${mode}`,
} as const;

function fileFor(key: string) {
  // Keys contain ":" and query characters — make them filename-safe.
  return new File(cacheDir, `${encodeURIComponent(key)}.json`);
}

export function cacheGet<T>(key: string): T | null {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const file = fileFor(key);
    if (!file.exists) return null;
    const value = JSON.parse(file.textSync()) as T;
    memory.set(key, value);
    return value;
  } catch {
    return null;
  }
}

export function cacheSet(key: string, value: unknown) {
  memory.set(key, value);
  try {
    if (!cacheDir.exists) cacheDir.create({ intermediates: true, idempotent: true });
    fileFor(key).write(JSON.stringify(value));
  } catch {
    // Persisting is best-effort — the memory copy still works this session.
  }
}

// Wipe everything on login/logout so one account can never see another
// account's cached data on a shared device.
export function clearDataCache() {
  memory.clear();
  try {
    if (cacheDir.exists) cacheDir.delete();
  } catch {
    // Ignore — worst case stale files linger in the OS-managed cache dir.
  }
}

// Pass `null` as the key to disable fetching (e.g. modal not visible yet,
// employeeId not known yet). `isLoading` is only true while there is
// nothing to show — once cached data exists, revalidation is silent.
export function useCachedData<T>(key: string | null, fetcher: () => Promise<T>) {
  const [data, setDataState] = useState<T | null>(() => (key ? cacheGet<T>(key) : null));
  const [isLoading, setIsLoading] = useState(key !== null && data === null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    if (!key) return;
    const fresh = await fetcherRef.current();
    cacheSet(key, fresh);
    setDataState(fresh);
  }, [key]);

  useEffect(() => {
    if (!key) return;
    const cached = cacheGet<T>(key);
    setDataState(cached);
    setIsLoading(cached === null);
    refresh()
      .catch((error) => console.error(`Failed to fetch ${key}`, error))
      .finally(() => setIsLoading(false));
  }, [key, refresh]);

  // For optimistic local updates (e.g. marking a notification read) — keeps
  // the cached copy in sync so the change survives closing the screen.
  const setData = useCallback(
    (value: T) => {
      setDataState(value);
      if (key) cacheSet(key, value);
    },
    [key],
  );

  return { data, isLoading, refresh, setData };
}
