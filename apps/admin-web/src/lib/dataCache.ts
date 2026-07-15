import { useCallback, useEffect, useRef, useState } from "react";
import { SessionExpiredError } from "./api";

// Stale-while-revalidate cache for read-only API data. Pages render the
// last successful response instantly (memory first, then localStorage,
// which survives reloads) while the real request runs in the background —
// so slow internet means "briefly stale data" instead of a spinner.
//
// Only GET-style reads go through this. Writes always hit the server
// directly and never touch the cache.

const memory = new Map<string, unknown>();
const STORAGE_PREFIX = "dataCache:";

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

export function cacheSet(key: string, value: unknown) {
  memory.set(key, value);
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded (e.g. responses with embedded photos) — the memory
    // copy still works for this session.
  }
}

// Wipe everything on login/logout so one account can never see another
// account's cached data in a shared browser.
export function clearDataCache() {
  memory.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Ignore — storage may be unavailable (private mode).
  }
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
    const fresh = await fetcherRef.current();
    cacheSet(key, fresh);
    setDataState(fresh);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (!key) return;
    const cached = cacheGet<T>(key);
    setDataState(cached);
    setIsLoading(cached === null);
    setError(null);
    refresh()
      .catch((err) => {
        if (err instanceof SessionExpiredError) return;
        console.error(`Failed to fetch ${key}`, err);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setIsLoading(false));
  }, [key, refresh]);

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
