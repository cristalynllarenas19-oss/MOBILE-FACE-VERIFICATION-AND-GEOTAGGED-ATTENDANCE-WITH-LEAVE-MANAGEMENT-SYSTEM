

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

  const [locations,    setLocations]    = useState<WorkLocation[]>([]);
  const [activeIdx,    setActiveIdx]    = useState(0);
  const [myPosition,   setMyPosition]   = useState<GeolocationPosition | null>(null);
  const [gpsError,     setGpsError]     = useState<string | null>(null);
  const [isLoading,    setIsLoading]    = useState(true);

  const mapRef      = useRef<L.Map | null>(null);
  const siteMarker  = useRef<L.Marker | null>(null);
  const siteCircle  = useRef<L.Circle | null>(null);
  const youMarker   = useRef<L.CircleMarker | null>(null);
  const watchId     = useRef<number | null>(null);

  // ── Load locations ────────────────────────────────────────────────────────
  useEffect(() => {
    setIsLoading(true);
    const fetch = isField ? getMyWorkLocations() : getMyWorkLocation().then((loc) => (loc ? [loc] : []));
    fetch
      .then((data) => setLocations(data ?? []))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [isField]);

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

  // ── Distance / inside-outside ─────────────────────────────────────────────
  let distanceBanner: { inside: boolean; text: string } | null = null;
  if (activeLocation && myPosition) {
    const { latitude, longitude } = myPosition.coords;
    const dist = distanceInMeters(
      latitude, longitude,
      Number(activeLocation.latitude), Number(activeLocation.longitude),
    );
    const r = Number(activeLocation.radiusMeters);
    const inside = dist <= r;
    distanceBanner = {
      inside,
      text: inside
        ? `You are inside ${activeLocation.name} (${Math.round(dist)}m from centre)`
        : `You are outside ${activeLocation.name} — ${Math.round(dist - r)}m beyond the boundary`,
    };
  }

  return (
    <div className="emp-page work-area-page">
      <h2 className="emp-page-title">Work Area</h2>

      <div className="work-area-shell">
        {/* ── Left: location switcher + info ── */}
        <div className="work-area-info">
          {isField && locations.length > 1 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {locations.map((loc, i) => (
                <button
                  key={loc.id}
                  onClick={() => setActiveIdx(i)}
                  style={{
                    padding: "7px 14px", borderRadius: 999, border: "none",
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                    background: activeIdx === i ? "#062B59" : "#F1F5F9",
                    color:      activeIdx === i ? "#FFFFFF"  : "#64748B",
                  }}
                >
                  {loc.name}
                </button>
              ))}
            </div>
          )}

          {activeLocation && (
            <div style={infoCard}>
              <MapPin size={16} color="#1680D8" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <p style={{ color: "#062B59", fontSize: 13, fontWeight: 700, margin: 0 }}>
                  {activeLocation.name}
                </p>
                <p style={{ color: "#64748B", fontSize: 12, margin: "2px 0 0" }}>
                  Geofence radius: {activeLocation.radiusMeters}m
                </p>
              </div>
            </div>
          )}

          {distanceBanner && (
            <div style={{
              ...bannerBase,
              background: distanceBanner.inside ? "#ECFDF3" : "#FEF2F2",
              borderColor: distanceBanner.inside ? "#BBF7D0" : "#FECACA",
              color: distanceBanner.inside ? "#17A34A" : "#DC2626",
            }}>
              <Navigation size={13} style={{ flexShrink: 0 }} />
              {distanceBanner.text}
            </div>
          )}

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
  background: "#EFF6FF", borderRadius: 12, padding: "10px 14px", marginBottom: 12,
};
const bannerBase: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  borderRadius: 10, border: "1px solid",
  padding: "9px 14px", marginBottom: 12,
  fontSize: 12, fontWeight: 600,
};
