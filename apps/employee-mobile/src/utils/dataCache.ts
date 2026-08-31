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
const inFlight = new Map<string, Promise<unknown>>();
const cacheDir = new Directory(Paths.cache, "data-cache");
// Every mounted useCachedData(key) instance subscribes here. A cacheSet for
// that key — whether triggered by that same hook's own refresh(), another
// component's hook for the same key, or a direct revalidateCached() call
// from unrelated code (e.g. the notification poll nudging leave data to
// refetch the moment a status-change notification arrives) — notifies all
// of them, so a screen that's just sitting open updates without the viewer
// having to do anything.
const subscribers = new Map<string, Set<(value: unknown) => void>>();

function notifySubscribers(key: string, value: unknown) {
  subscribers.get(key)?.forEach((listener) => listener(value));
}

export const CACHE_KEYS = {
  myProfile: "my-profile",
  notifications: "notifications",
  notificationsUnreadCount: "notifications:unread-count",
  leaveTypes: "leave-types",
  todayAttendance: (employeeId: string) => `today-attendance:${employeeId}`,
  attendanceEligibility: (employeeId: string) => `attendance-eligibility:${employeeId}`,
  attendanceHistory: (employeeId: string) => `attendance-history:${employeeId}`,
  leaveBalances: (employeeId: string) => `leave-balances:${employeeId}`,
  leaveRequests: (employeeId: string) => `leave-requests:${employeeId}`,
  mySchedules: (employeeId: string) => `my-schedules:${employeeId}`,
  undertimeEligibility: (employeeId: string) => `undertime-eligibility:${employeeId}`,
  undertimeFilings: (employeeId: string) => `undertime-filings:${employeeId}`,
  workArea: (employeeId: string, mode: "field" | "fixed") => `work-area:${employeeId}:${mode}`,
  supervisorDashboard: "supervisor-dashboard",
  teamEmployees: "team-employees",
  teamLeaveRequests: "team-leave-requests",
  teamSchedules: "team-schedules",
  teamReportsSummary: "team-reports-summary",
  geotaggedLocations: "geotagged-locations",
  teamAttendance: (date: string) => `team-attendance:${date}`,
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
  notifySubscribers(key, value);
}

// Wipe everything on login/logout so one account can never see another
// account's cached data on a shared device.
export function clearDataCache() {
  memory.clear();
  inFlight.clear();
  try {
    if (cacheDir.exists) cacheDir.delete();
  } catch {
    // Ignore — worst case stale files linger in the OS-managed cache dir.
  }
}

// All consumers of the same resource share one network request. This avoids
// a tab mount, header, and background prefetch each fetching the same data at
// once, while still making every successful response available immediately to
// the next screen.
export function revalidateCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = fetcher()
    .then((fresh) => {
      cacheSet(key, fresh);
      return fresh;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

// Starts a stale-while-revalidate fetch without making the caller wait. Used
// after sign-in so tabs are ready by the time the employee opens them.
export function prefetchCached<T>(key: string, fetcher: () => Promise<T>) {
  void revalidateCached(key, fetcher).catch(() => undefined);
}

// Pass `null` as the key to disable fetching (e.g. modal not visible yet,
// employeeId not known yet). `isLoading` is only true while there is
// nothing to show — once cached data exists, revalidation is silent.
export function useCachedData<T>(key: string | null, fetcher: () => Promise<T>) {
  const [data, setDataState] = useState<T | null>(() => (key ? cacheGet<T>(key) : null));
  const [isLoading, setIsLoading] = useState(key !== null && data === null);
  // Distinguishes "the request failed" from "the request succeeded with
  // nothing" — without this, a network/auth error and a genuinely empty
  // result render identically (see DTRScreen's empty state).
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    if (!key) return;
    try {
      const fresh = await revalidateCached(key, fetcherRef.current);
      setDataState(fresh);
      setError(null);
      return fresh;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
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

  useEffect(() => {
    if (!key) return;
    const listener = (value: unknown) => setDataState(value as T);
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key)!.add(listener);
    return () => {
      subscribers.get(key)?.delete(listener);
      if (subscribers.get(key)?.size === 0) subscribers.delete(key);
    };
  }, [key]);

  // For optimistic local updates (e.g. marking a notification read) — keeps
  // the cached copy in sync so the change survives closing the screen.
  const setData = useCallback(
    (value: T) => {
      setDataState(value);
      if (key) cacheSet(key, value);
    },
    [key],
  );

  return { data, isLoading, error, refresh, setData };
}
