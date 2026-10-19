import { useEffect, useRef } from "react";

// There's no push channel (WebSocket/SSE) in this app, so "live" pages poll:
// every LIVE_REFRESH_MS while the tab is visible, and straight away when the
// admin comes back to the tab — so a change made elsewhere (another admin, a
// supervisor on mobile, an employee clocking in) shows up without a reload or
// switching screens. Hidden tabs don't poll at all, which keeps the load on
// the backend/database proportional to people actually looking.
export const LIVE_REFRESH_MS = 10_000;

export function useLiveRefresh(refresh: () => unknown, enabled = true, intervalMs = LIVE_REFRESH_MS) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      if (document.visibilityState !== "visible") return;
      try {
        Promise.resolve(refreshRef.current()).catch(() => undefined);
      } catch {
        // A failed background refresh just leaves the current data on screen.
      }
    };

    const interval = window.setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
    };
  }, [enabled, intervalMs]);
}
