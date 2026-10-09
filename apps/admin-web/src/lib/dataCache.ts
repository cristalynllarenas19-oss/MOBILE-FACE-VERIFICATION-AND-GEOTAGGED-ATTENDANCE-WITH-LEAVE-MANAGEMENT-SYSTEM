import { useCallback, useEffect, useRef, useState } from "react";
import { SessionExpiredError } from "./api";

// Stale-while-revalidate cache for read-only API data. Pages render the
// last successful response instantly while the real request runs in the
// background — so slow internet means "briefly stale data" instead of a
// spinner. Mirrors employee-mobile's src/utils/dataCache.ts so both apps
// behave the same way and feel equally fast.
//
// Only GET-style reads go through this. Writes always hit the server
// directly and never touch the cache.
//
// Three tiers, each one a fallback for the one before it:
//   1. memory   — instant, but gone on a page reload.
//   2. localStorage — synchronous (no flash of "loading" even on a hard
//      reload), but capped around 5-10MB per origin, so a write can fail.
//   3. IndexedDB — asynchronous (a single-digit-millisecond read, still far
//      faster than the network) but effectively unbounded. Every write also
//      goes here unconditionally, so it's the backstop for the rare
//      responses too big for localStorage (attendance history embeds base64
//      face photos per log and can blow past that cap on its own) — those
//      entries just resolve a few ms later on reload instead of not
//      persisting at all.

const memory = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();
const STORAGE_PREFIX = "dataCache:";
// Every mounted useCachedData(key) instance subscribes here. A cacheSet for
// that key — whether triggered by that same hook's own refresh(), another
// component's hook for the same key, or a direct revalidateCached() call
// from unrelated code (e.g. the notification poll nudging leave data to
// refetch the moment a status-change notification arrives) — notifies all
// of them, so a page that's just sitting open updates without the viewer
// having to do anything.
const subscribers = new Map<string, Set<(value: unknown) => void>>();

function notifySubscribers(key: string, value: unknown) {
  subscribers.get(key)?.forEach((listener) => listener(value));
}

const DB_NAME = "adminWebDataCache";
const STORE_NAME = "kv";

// Cache keys shared by the employee self-service pages (mirrors
// employee-mobile's CACHE_KEYS) — kept here so admin-web's Employee Portal
// pages and any future prefetching agree on the same key for the same
// resource.
export const CACHE_KEYS = {
  myProfile: "my-profile",
  notifications: "notifications",
  notificationsUnreadCount: "notifications:unread-count",
  leaveTypes: "leave-types",
  todayAttendance: (employeeId: string) => `today-attendance:${employeeId}`,
  attendanceHistory: (employeeId: string) => `attendance-history:${employeeId}`,
  leaveBalances: (employeeId: string) => `leave-balances:${employeeId}`,
  leaveRequests: (employeeId: string) => `leave-requests:${employeeId}`,
  mySchedules: (employeeId: string) => `my-schedules:${employeeId}`,
  undertimeEligibility: (employeeId: string) => `undertime-eligibility:${employeeId}`,
  undertimeFilings: (employeeId: string) => `undertime-filings:${employeeId}`,
  workArea: (employeeId: string, mode: "field" | "fixed") => `work-area:${employeeId}:${mode}`,
} as const;

// ── IndexedDB (durable L2) ───────────────────────────────────────────────────
// Best-effort throughout: a missing/broken IndexedDB (old browser, private
// mode) just means every page behaves like a fresh install — the memory
// layer and the network still work.

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbSet(key: string, value: unknown) {
  openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value, key);
    } catch {
      // Best-effort — the memory copy still works for this session.
    }
  });
}

function idbClear() {
  openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear();
    } catch {
      // Ignore.
    }
  });
}

// Synchronous: memory, then localStorage. This is the fast path that keeps
// a hard reload flash-free for every page whose cached response is small
// enough to have made it into localStorage.
export function cacheGet<T>(key: string): T | null {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return null;
    const value = JSON.parse(raw) as T;
    memory.set(key, value);
    return value;
  } catch {
    return null;
  }
}

// Falls through to IndexedDB when the synchronous tiers above missed —
// either the key was never cached, or it's one of the few responses too big
// for localStorage. Still a single-digit-millisecond read, so even this
// path beats the network by a wide margin. Populates memory on a hit so
// every later read of this key is the fully synchronous path above.
async function cacheGetAsync<T>(key: string): Promise<T | null> {
  const sync = cacheGet<T>(key);
  if (sync !== null) return sync;
  const value = await idbGet<T>(key);
  if (value !== null) memory.set(key, value);
  return value;
}

export function cacheSet(key: string, value: unknown) {
  memory.set(key, value);
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded — IndexedDB below is the backstop for this key.
  }
  idbSet(key, value);
  notifySubscribers(key, value);
}

// Wipe everything on login/logout so one account can never see another
// account's cached data in a shared browser.
export function clearDataCache() {
  memory.clear();
  inFlight.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Ignore — storage may be unavailable (private mode).
  }
  idbClear();
}

// All consumers of the same resource share one network request. This avoids
// a page mount and a background prefetch both fetching the same data at
// once, while still making every successful response available immediately
// to the next page that reads the same key.
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
// right after sign-in so pages are ready by the time the admin/employee
// navigates to them.
export function prefetchCached<T>(key: string, fetcher: () => Promise<T>) {
  void revalidateCached(key, fetcher).catch(() => undefined);
}

// Pass `null` as the key to disable fetching (e.g. a required id isn't
// known yet). `isLoading` is only true while there is nothing to show —
// once cached data exists, revalidation is silent.
export function useCachedData<T>(key: string | null, fetcher: () => Promise<T>) {
  const [data, setDataState] = useState<T | null>(() => (key ? cacheGet<T>(key) : null));
  const [isLoading, setIsLoading] = useState(key !== null && data === null);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    if (!key) return;
    const fresh = await revalidateCached(key, fetcherRef.current);
    setDataState(fresh);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    const syncHit = cacheGet<T>(key);
    setDataState(syncHit);
    setIsLoading(syncHit === null);
    setError(null);

    // Synchronous tiers missed — either truly uncached, or this key's last
    // write was too big for localStorage (falls back to IndexedDB only).
    // Still a lot faster than the network, so check it without waiting for
    // the network call below to land.
    if (syncHit === null) {
      cacheGetAsync<T>(key).then((diskHit) => {
        if (cancelled || diskHit === null) return;
        // Functional update so a network response that already landed first
        // (rare, but possible) is never clobbered by the slower disk read.
        setDataState((current) => (current === null ? diskHit : current));
        setIsLoading(false);
      });
    }

    refresh()
      .catch((err) => {
        if (err instanceof SessionExpiredError) return;
        console.error(`Failed to fetch ${key}`, err);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
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

  // For optimistic local updates — keeps the cached copy in sync so the
  // change survives navigating away and back.
  const setData = useCallback(
    (value: T) => {
      setDataState(value);
      if (key) cacheSet(key, value);
    },
    [key],
  );

  return { data, isLoading, error, refresh, setData };
}
