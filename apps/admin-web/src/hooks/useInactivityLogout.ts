import { useEffect, useRef } from "react";

const INACTIVITY_MS = 15 * 60 * 1000;
const CHECK_INTERVAL_MS = 30_000;

const EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
  "touchmove",
] as const;

export function useInactivityLogout(onLogout: () => void, active: boolean) {
  const callbackRef = useRef(onLogout);
  callbackRef.current = onLogout;
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    if (!active) return;

    lastActivityRef.current = Date.now();

    const touch = () => { lastActivityRef.current = Date.now(); };

    const opts = { passive: true } as const;
    EVENTS.forEach((e) => window.addEventListener(e, touch, opts));

    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= INACTIVITY_MS) {
        clearInterval(interval);
        callbackRef.current();
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      EVENTS.forEach((e) => window.removeEventListener(e, touch, opts));
    };
  }, [active]);
}
