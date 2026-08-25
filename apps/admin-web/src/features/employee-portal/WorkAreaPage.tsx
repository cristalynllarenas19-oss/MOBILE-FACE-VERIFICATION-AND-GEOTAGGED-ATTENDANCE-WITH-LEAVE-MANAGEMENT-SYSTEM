

import "leaflet/dist/leaflet.css";
import "./WorkAreaPage.css";
import "./EmployeePortal.css";

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import { MapPin, Navigation } from "lucide-react";
import { WorkLocation, getMyWorkLocation, getMyWorkLocations, distanceInMeters } from "./api";
import type { AuthUser } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";

type Props = { user: AuthUser };

const siteMarkerIcon = L.icon({
  iconRetinaUrl: markerIcon2xUrl,
  iconUrl: markerIconUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
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
      .bindPopup(`<b>${activeLocation.name}</b><br>Radius: ${r}m`);

    siteCircle.current = L.circle([lat, lng], {
      radius: r,
      color: "#1680D8",
      fillColor: "#1680D8",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(map);

    map.setView([lat, lng], 16);
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
    }).addTo(map).bindTooltip("You are here");
  }, [myPosition]);

  // ── Distance / inside-outside — computed per-location so every card can
  // show its own status, not just whichever one is active on the map ───────
  function getDistanceStatus(loc: WorkLocation): { inside: boolean; text: string } | null {
    if (!myPosition) return null;
    const { latitude, longitude } = myPosition.coords;
    const dist = distanceInMeters(latitude, longitude, Number(loc.latitude), Number(loc.longitude));
    const r = Number(loc.radiusMeters);
    const inside = dist <= r;
    return {
      inside,
      text: inside
        ? `Inside — ${Math.round(dist)}m from centre`
        : `Outside — ${Math.round(dist - r)}m beyond the boundary`,
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
            return (
              <div key={loc.id} style={{ display: "flex", flexWrap: "wrap", gap: 12, flex: "1 1 100%" }}>
                <button
                  onClick={() => setActiveIdx(i)}
                  style={{
                    ...infoCard,
                    cursor: locations.length > 1 ? "pointer" : "default",
                    outline: isActive && locations.length > 1 ? "2px solid #1680D8" : "none",
                    outlineOffset: 2,
                    textAlign: "left",
                  }}
                >
                  <MapPin size={16} color="#1680D8" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ color: "#062B59", fontSize: 13, fontWeight: 700, margin: 0 }}>
                      {loc.name}
                    </p>
                    <p style={{ color: "#64748B", fontSize: 12, margin: "2px 0 0" }}>
                      Geofence radius: {loc.radiusMeters}m
                    </p>
                  </div>
                </button>

                {status && (
                  <div style={{
                    ...bannerBase,
                    background: status.inside ? "#ECFDF3" : "#FEF2F2",
                    borderColor: status.inside ? "#BBF7D0" : "#FECACA",
                    color: status.inside ? "#17A34A" : "#DC2626",
                  }}>
                    <Navigation size={13} style={{ flexShrink: 0 }} />
                    {loc.name}: {status.text}
                  </div>
                )}
              </div>
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

const infoCard: CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 10,
  background: "#FFFFFF", borderRadius: 12, padding: "10px 14px",
  flex: "1 1 240px",
  border: "none",
  boxShadow: "0 1px 3px rgba(6, 43, 89, 0.06), 0 1px 2px rgba(6, 43, 89, 0.04)",
  font: "inherit", margin: 0,
};
const bannerBase: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  borderRadius: 10, border: "1px solid",
  padding: "9px 14px",
  fontSize: 12, fontWeight: 600,
  flex: "1 1 240px",
};
