

import "leaflet/dist/leaflet.css";
import "./WorkAreaPage.css";
import "./EmployeePortal.css";

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import { AlertCircle, CheckCircle2, MapPin } from "lucide-react";
import { WorkLocation, getMyWorkLocation, getMyWorkLocations, distanceInMeters } from "./api";
import type { AuthUser } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";

type Props = { user: AuthUser };

// No shadowUrl — Leaflet's default drop-shadow is a skewed, hard-edged
// shape that doesn't sit under the pin the way a shadow normally would,
// which read as "the pointer isn't aligned" next to the rest of this page's
// flat, soft-shadow design language. A plain pin reads cleaner.
const siteMarkerIcon = L.icon({
  iconRetinaUrl: markerIcon2xUrl,
  iconUrl: markerIconUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  // Same value Leaflet's own L.Icon.Default uses for this exact marker
  // image — clears the pin's point so the hover tooltip sits above it
  // instead of overlapping the tip.
  tooltipAnchor: [16, -28],
});

export function WorkAreaPage({ user }: Props) {
  const isField = user.attendanceMode === "FIELD";

  // Stale-while-revalidate — same cache keys AttendancePage/App.tsx prefetch
  // warm, so this map has its site(s) ready the instant the page mounts.
  // Keeps the same per-mode cache shape as AttendancePage/employee-mobile:
  // "field" stores an array, "fixed" stores a single object (or null).
  const workLocationsCache = useCachedData<WorkLocation[]>(
    isField && user.employeeId ? CACHE_KEYS.workArea(user.employeeId, "field") : null,
    getMyWorkLocations,
  );
  const workLocationCache = useCachedData<WorkLocation | null>(
    !isField && user.employeeId ? CACHE_KEYS.workArea(user.employeeId, "fixed") : null,
    getMyWorkLocation,
  );
  const locations = isField
    ? workLocationsCache.data ?? []
    : workLocationCache.data ? [workLocationCache.data] : [];
  const isLoading = isField ? workLocationsCache.isLoading : workLocationCache.isLoading;
  const [activeIdx,    setActiveIdx]    = useState(0);
  const [myPosition,   setMyPosition]   = useState<GeolocationPosition | null>(null);
  const [gpsError,     setGpsError]     = useState<string | null>(null);

  const mapRef      = useRef<L.Map | null>(null);
  const siteMarker  = useRef<L.Marker | null>(null);
  const siteCircle  = useRef<L.Circle | null>(null);
  const youMarker   = useRef<L.CircleMarker | null>(null);
  const watchId     = useRef<number | null>(null);

  // ── GPS watch ─────────────────────────────────────────────────────────────
  useEffect(() => {
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => { setMyPosition(pos); setGpsError(null); },
      (err) => setGpsError(err.message),
      { enableHighAccuracy: true },
    );
    return () => { if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current); };
  }, []);

  // ── Init Leaflet map ─────────────────────────────────────────────────────
  // Callback ref (not a mount-only effect) because the map <div> is only
  // rendered once loading finishes / locations exist, so the node doesn't
  // exist yet on first mount.
  const mapDivRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      if (!mapRef.current) {
        mapRef.current = L.map(node, { zoomControl: true }).setView([16.3222, 120.3656], 15);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap",
        }).addTo(mapRef.current);
      }
    } else {
      mapRef.current?.remove();
      mapRef.current = null;
    }
  }, []);

  // ── Update site marker + circle when active location changes ──────────────
  const activeLocation = locations[activeIdx] ?? null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeLocation) return;

    const lat = Number(activeLocation.latitude);
    const lng = Number(activeLocation.longitude);
    const r   = Number(activeLocation.radiusMeters);

    siteMarker.current?.remove();
    siteCircle.current?.remove();

    siteMarker.current = L.marker([lat, lng], { icon: siteMarkerIcon })
      .addTo(map)
      .bindTooltip(
        `<div class="site-tooltip-title">${activeLocation.name}</div><div class="site-tooltip-meta">Radius: ${r}m</div>`,
        // Hover, not click — matches the "You are here" tooltip below, so
        // neither label needs an extra click to read. Positioning comes
        // from the icon's own tooltipAnchor above.
        { className: "site-tooltip", direction: "top" },
      );

    siteCircle.current = L.circle([lat, lng], {
      radius: r,
      color: "#1680D8",
      fillColor: "#1680D8",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(map);
  }, [activeLocation]);

  // ── Update "you are here" marker ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !myPosition) return;
    const { latitude, longitude } = myPosition.coords;

    youMarker.current?.remove();
    youMarker.current = L.circleMarker([latitude, longitude], {
      radius: 8,
      fillColor: "#17A34A",
      color: "#fff",
      weight: 2,
      fillOpacity: 1,
    }).addTo(map).bindTooltip("You are here", {
      className: "you-are-here-tooltip",
      direction: "top",
      offset: [0, -10],
    });
  }, [myPosition]);

  // ── Fit/centre the view — matches employee-mobile's buildMapHtml: zoom to
  // the site alone until a GPS fix is in, then fitBounds once to frame both
  // the site and "you are here" together. Previously this only ever centred
  // on the site (web never adjusted for the user's position), so the same
  // real-world location could look framed completely differently between
  // the two apps. Only fits once per site — unlike mobile's one-shot GPS
  // read, web's watchPosition keeps ticking, and re-fitting on every tick
  // would keep yanking the view back if the employee pans/zooms to look
  // around. ───────────────────────────────────────────────────────────────
  const hasAutoFitRef = useRef(false);

  useEffect(() => {
    hasAutoFitRef.current = false;
  }, [activeLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeLocation || hasAutoFitRef.current) return;
    const lat = Number(activeLocation.latitude);
    const lng = Number(activeLocation.longitude);

    if (myPosition) {
      const bounds = L.latLngBounds([
        [lat, lng],
        [myPosition.coords.latitude, myPosition.coords.longitude],
      ]);
      map.fitBounds(bounds, { padding: [40, 40] });
      hasAutoFitRef.current = true;
    } else {
      map.setView([lat, lng], 16);
    }
  }, [activeLocation, myPosition]);

  // ── Distance / inside-outside — computed per-location so every card can
  // show its own status, not just whichever one is active on the map ───────
  // Inside, the headline number is "how far from the pin" (small = well
  // within range); outside, it's more useful as "how far past the fence"
  // than the raw distance from a centre point you're nowhere near. Mirrors
  // employee-mobile's WorkAreaScreen.
  function getDistanceStatus(loc: WorkLocation): { inside: boolean; heroValue: number; label: string } | null {
    if (!myPosition) return null;
    const { latitude, longitude } = myPosition.coords;
    const dist = distanceInMeters(latitude, longitude, Number(loc.latitude), Number(loc.longitude));
    const r = Number(loc.radiusMeters);
    const inside = dist <= r;
    return {
      inside,
      heroValue: Math.round(inside ? dist : dist - r),
      label: inside ? "from centre — inside the work area" : "beyond the boundary",
    };
  }

  return (
    <div className="emp-page work-area-page">
      <h2 className="emp-page-title">Work Area</h2>

      <div className="work-area-shell">
        {/* ── Top: one card per assigned location — clicking a card makes it
            active on the map below. Each card shows its own geofence radius
            and, once a GPS fix is available, its own inside/outside status. ── */}
        <div className="work-area-info">
          {locations.map((loc, i) => {
            const status = getDistanceStatus(loc);
            const isActive = i === activeIdx;
            const iconColor = !status ? "#1680D8" : status.inside ? "#17A34A" : "#DC2626";
            return (
              <button
                key={loc.id}
                onClick={() => setActiveIdx(i)}
                style={{
                  ...siteCard,
                  cursor: locations.length > 1 ? "pointer" : "default",
                  outline: isActive && locations.length > 1 ? "2px solid #1680D8" : "none",
                  outlineOffset: 2,
                }}
              >
                <div style={{
                  ...siteCardAccent,
                  background: !status ? "#1680D8" : status.inside ? "#17A34A" : "#DC2626",
                }} />
                <div style={siteCardInner}>
                  <p style={siteCardEyebrow}>WORK AREA</p>

                  <div style={siteCardTopRow}>
                    <div style={{ ...siteIconWrap, background: !status ? "#EFF6FF" : status.inside ? "#ECFDF3" : "#FEF2F2" }}>
                      <MapPin size={16} color={iconColor} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ color: "#062B59", fontSize: 14, fontWeight: 700, margin: 0 }}>
                        {loc.name}
                      </p>
                      <p style={{ color: "#64748B", fontSize: 12.5, margin: "2px 0 0" }}>
                        Authorized radius: {loc.radiusMeters}m
                      </p>
                    </div>
                    {status && (
                      <span style={{
                        ...statusBadge,
                        background: status.inside ? "#ECFDF3" : "#FEF2F2",
                        color: status.inside ? "#17A34A" : "#DC2626",
                      }}>
                        {status.inside ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                        {status.inside ? "In range" : "Out of range"}
                      </span>
                    )}
                  </div>

                  {status && (
                    <>
                      <div style={siteCardDivider} />
                      <div style={{ textAlign: "center" }}>
                        <p style={distanceValueStyle}>
                          {Math.abs(status.heroValue)}<span style={distanceUnitStyle}> m</span>
                        </p>
                        <p style={distanceLabelStyle}>{status.label}</p>
                      </div>
                    </>
                  )}
                </div>
              </button>
            );
          })}

          {gpsError && (
            <div style={{ ...bannerBase, background: "#FFFBEB", borderColor: "#FDE68A", color: "#D97706" }}>
              GPS unavailable: {gpsError}
            </div>
          )}
        </div>

        {/* ── Right: map ── */}
        <div className="work-area-map-col">
          {isLoading ? (
            <div className="work-area-map-placeholder">
              <p style={{ color: "#94A3B8" }}>Loading map…</p>
            </div>
          ) : locations.length === 0 ? (
            <div className="work-area-map-placeholder">
              <MapPin size={32} color="#CBD5E1" />
              <p style={{ color: "#94A3B8", fontSize: 13, fontWeight: 600, marginTop: 8, textAlign: "center" }}>
                {isField
                  ? "No client/work sites have been assigned to you yet."
                  : "No geotagged work area has been assigned to you yet."}
              </p>
              <p style={{ color: "#CBD5E1", fontSize: 12, marginTop: 4, textAlign: "center" }}>
                {isField
                  ? "Contact your supervisor if you believe this is a mistake."
                  : "Contact HR if you believe this is a mistake."}
              </p>
            </div>
          ) : (
            <div ref={mapDivRef} className="work-area-map-div" />
          )}
        </div>
      </div>
    </div>
  );
}

// Mirrors employee-mobile's WorkAreaScreen card: a status accent strip, an
// icon badge + name/radius row, and — once a GPS fix is in — a divider and
// a big hero distance reading.
const siteCard: CSSProperties = {
  display: "block", textAlign: "left",
  background: "#FFFFFF", borderRadius: 18, padding: 0,
  flex: "1 1 280px", overflow: "hidden",
  border: "1px solid #E2E8F0",
  boxShadow: "var(--emp-shadow-card)",
  font: "inherit", margin: 0,
};
// Thin status strip across the top of the card — neutral blue until a GPS
// fix lands, then reacts to in/out-of-range like the icon badge below it.
const siteCardAccent: CSSProperties = {
  height: 4, background: "#1680D8",
};
const siteCardInner: CSSProperties = {
  padding: 12,
};
const siteCardEyebrow: CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#94A3B8", letterSpacing: 0.6, margin: "0 0 6px",
};
const siteCardTopRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
};
const siteIconWrap: CSSProperties = {
  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
  background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center",
};
const siteCardDivider: CSSProperties = {
  height: 1, background: "#F1F5F9", margin: "8px 0 6px",
};
const statusBadge: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  borderRadius: 8, padding: "3px 7px",
  fontSize: 10.5, fontWeight: 700,
};
// The hero: this is what the card exists to show once a GPS fix is in.
const distanceValueStyle: CSSProperties = {
  fontSize: 22, fontWeight: 800, color: "#062B59", letterSpacing: -0.5, margin: 0,
};
const distanceUnitStyle: CSSProperties = {
  fontSize: 13, fontWeight: 700, color: "#64748B",
};
const distanceLabelStyle: CSSProperties = {
  fontSize: 12, color: "#64748B", margin: "1px 0 0",
};
const bannerBase: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  borderRadius: 10, border: "1px solid",
  padding: "9px 14px",
  fontSize: 12, fontWeight: 600,
  flex: "1 1 240px",
};
