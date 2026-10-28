import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, RefreshControl, Pressable, AppState } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import { WorkLocation, getMyWorkLocation, getMyWorkLocations } from "../api";
import { CACHE_KEYS, useCachedData } from "../utils/dataCache";
import { GeofenceBoundary, distanceInMeters, distanceOutsideGeofence, isPolygonArea } from "../utils/geofence";
import { LEAFLET_ICONS, MAP_WEBVIEW_CACHE_MODE, OSM_TILE_URL, leafletHeadHtml } from "../utils/leafletHtml";
import AestheticScrollView from "../components/AestheticScrollView";
import EmptyState from "../components/EmptyState";

type Props = {
  employeeId?: string;
  attendanceMode?: string;
};

// How often the open Work Area tab re-checks the assigned area, so an HR
// edit (coordinates, radius, name) shows up on the map while the employee is
// just looking at it. Only runs while this tab is mounted and the app is in
// the foreground; App.tsx's slower WORK_LOCATION_SYNC_MS covers the rest.
const WORK_AREA_POLL_MS = 10000;

// Everything the map draws. Pushed into the already-loaded WebView with
// injectJavaScript on every change, so the marker, circle and centre move in
// place instead of the whole Leaflet page being torn down and reloaded.
type MapState = {
  // boundary set = a polygon area, drawn instead of the radius circle.
  site: { name: string; lat: number; lon: number; radius: number; boundary: GeofenceBoundary | null };
  user: { lat: number; lon: number } | null;
};

// "<" escaped so a site name can never close the inline <script> early.
function toScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildMapHtml(initialState: MapState) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  ${leafletHeadHtml()}
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; }

    /* Restyled zoom control — matches the app's card language instead of
       Leaflet's bare, dated-looking default squares (mirrors admin-web's
       WorkAreaPage.css). */
    .leaflet-control-zoom {
      border: none !important;
      border-radius: 12px !important;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(6, 43, 89, 0.06), 0 1px 2px rgba(6, 43, 89, 0.04);
    }
    .leaflet-control-zoom a {
      width: 34px !important;
      height: 34px !important;
      line-height: 34px !important;
      background: #FFFFFF !important;
      color: #062B59 !important;
      font-size: 18px !important;
      font-weight: 700 !important;
      border: none !important;
    }
    .leaflet-control-zoom-in {
      border-bottom: 1px solid #EEF2F6 !important;
    }
    .leaflet-control-attribution {
      border-radius: 8px 0 0 0 !important;
      font-size: 10px !important;
    }

    /* Popup bubbles — styled badges instead of Leaflet's plain white boxes
       (mirrors admin-web's WorkAreaPage.css). Navy for the site name, green
       for "You are here" (matches the green location dot, and skips the
       close button since there's nothing more to read). */
    .site-popup .leaflet-popup-content-wrapper {
      background: #062B59; color: #FFFFFF; border-radius: 12px;
      box-shadow: 0 6px 18px rgba(6, 43, 89, 0.3);
    }
    .site-popup .leaflet-popup-content { margin: 10px 12px; font-size: 12px; line-height: 1.3; }
    .site-popup-title { font-size: 12.5px; font-weight: 800; color: #FFFFFF; margin: 0 0 2px; letter-spacing: -0.1px; text-align: center; }
    .site-popup-meta { font-size: 10.5px; font-weight: 600; color: rgba(255,255,255,0.68); text-align: center; }
    .site-popup .leaflet-popup-tip { background: #062B59; box-shadow: none; }
    .site-popup .leaflet-popup-close-button {
      color: rgba(255,255,255,0.65) !important;
      top: 6px !important; right: 8px !important;
      font-size: 14px !important; font-weight: 700 !important;
    }
    .you-popup .leaflet-popup-content-wrapper {
      background: #17A34A; color: #FFFFFF; border-radius: 10px;
      box-shadow: 0 4px 14px rgba(23, 163, 74, 0.3);
    }
    .you-popup .leaflet-popup-content { margin: 6px 12px; font-size: 11.5px; font-weight: 700; }
    .you-popup .leaflet-popup-tip { background: #17A34A; box-shadow: none; }
    .you-popup .leaflet-popup-close-button { display: none; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const map = L.map('map');
    L.tileLayer('${OSM_TILE_URL}', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // No shadowUrl — Leaflet's default drop-shadow is a skewed, hard-edged
    // shape that doesn't sit under the pin the way a shadow normally would,
    // which read as "the pointer isn't aligned" (mirrors admin-web's
    // WorkAreaPage.tsx). A plain pin reads cleaner.
    const siteIcon = L.icon({
      iconUrl: ${JSON.stringify(LEAFLET_ICONS.marker)},
      iconRetinaUrl: ${JSON.stringify(LEAFLET_ICONS.marker2x)},
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
    });

    function escapeHtml(text) {
      return String(text).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    let siteMarker = null;
    let siteCircle = null;
    let userMarker = null;
    let lastSiteKey = null;

    // Called once below with the initial state, then again by the app via
    // injectJavaScript whenever the area or the GPS fix changes.
    window.applyMapState = function (state) {
      const site = state.site;
      const sitePos = [site.lat, site.lon];
      const popupHtml =
        '<div class="site-popup-title">' + escapeHtml(site.name) + '</div>' +
        '<div class="site-popup-meta">' + (site.boundary ? 'Polygon area' : 'Radius: ' + site.radius + 'm') + '</div>';

      if (!siteMarker) {
        siteMarker = L.marker(sitePos, { icon: siteIcon }).addTo(map).bindPopup(popupHtml, {
          // minWidth stops a short name (e.g. "SLC") from shrinking the whole
          // bubble down to it — "Radius: 120m" then has nowhere to go but
          // wrap/overlap the close button. Not so wide that it dwarfs the map.
          className: 'site-popup', minWidth: 130
        });
      } else {
        siteMarker.setLatLng(sitePos).setPopupContent(popupHtml);
      }

      // Rebuilt rather than moved — the area may have switched between a
      // circle and a polygon.
      if (siteCircle) map.removeLayer(siteCircle);
      const areaStyle = { color: '#1680D8', fillColor: '#1680D8', fillOpacity: 0.15 };
      siteCircle = (site.boundary
        // One polygon per part (several buildings) — a plain list of rings
        // would draw every part after the first as a hole.
        ? L.polygon(site.boundary.map(function (ring) { return [ring]; }), areaStyle)
        : L.circle(sitePos, Object.assign({ radius: site.radius }, areaStyle))
      ).addTo(map);

      const hadUser = userMarker !== null;
      if (state.user) {
        const userPos = [state.user.lat, state.user.lon];
        if (userMarker) {
          userMarker.setLatLng(userPos);
        } else {
          userMarker = L.circleMarker(userPos, {
            radius: 8, color: '#FFFFFF', weight: 2, fillColor: '#17A34A', fillOpacity: 1
          }).addTo(map).bindPopup('You are here', { className: 'you-popup' });
        }
      } else if (userMarker) {
        map.removeLayer(userMarker);
        userMarker = null;
      }

      // Re-frame only when the area itself moved/resized (or a GPS fix first
      // appears) — a routine GPS update shouldn't yank the view away from
      // wherever the employee has panned/zoomed to.
      const siteKey = site.lat + ',' + site.lon + ',' + site.radius + ',' + JSON.stringify(site.boundary);
      if (siteKey !== lastSiteKey || (!hadUser && userMarker)) {
        lastSiteKey = siteKey;
        // A polygon is framed whole; a circle by its pin.
        const bounds = site.boundary ? siteCircle.getBounds() : L.latLngBounds([sitePos]);
        if (state.user) {
          map.fitBounds(bounds.extend([state.user.lat, state.user.lon]), { padding: [40, 40] });
        } else if (site.boundary) {
          map.fitBounds(bounds, { padding: [40, 40] });
        } else {
          map.setView(sitePos, 16);
        }
      }
    };

    window.applyMapState(${toScriptJson(initialState)});
  </script>
</body>
</html>`;
}

export default function WorkAreaScreen({ employeeId, attendanceMode }: Props) {
  const isField = attendanceMode === "FIELD";
  const cacheKey = employeeId ? CACHE_KEYS.workArea(employeeId, isField ? "field" : "fixed") : null;

  // Subscribed to the shared cache entry, so this screen re-renders whenever
  // *any* fetch of it lands — its own poll below, App.tsx's background sync,
  // or the foreground/Time-In refreshes — not just the one fetch it made on
  // mount. Failed fetches leave the last good copy in place.
  const { data: area, isLoading, error, refresh } = useCachedData<WorkLocation[] | WorkLocation | null>(
    cacheKey,
    isField ? getMyWorkLocations : getMyWorkLocation,
  );
  const workLocations = isField && Array.isArray(area) ? area : [];
  const workLocation = !isField && area && !Array.isArray(area) ? area : null;

  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<Location.LocationObjectCoords | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // GPS is useful for the distance badge, not for rendering the assigned
  // work area. Load it in the background so the map is never held up. The
  // phone's last known fix (instant, no satellite wait) is shown first, then
  // replaced by a fresh one — a cold GPS fix can otherwise take 10s+ indoors.
  const refreshUserLocation = useCallback(() => {
    void Location.requestForegroundPermissionsAsync()
      .then(async (permission) => {
        if (!permission.granted) return;
        const cached = await Location.getLastKnownPositionAsync().catch(() => null);
        if (cached) setUserLocation(cached.coords);
        const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setUserLocation(fresh.coords);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshUserLocation();
  }, [refreshUserLocation]);

  // Poll while this tab is open, and re-check the moment the app returns to
  // the foreground (timers are suspended in the background, so that's when a
  // missed edit is most likely). revalidateCached shares one in-flight
  // request per key, so this never stacks on top of App.tsx's own sync; a
  // failed tick just retries on the next one once connectivity is back.
  useEffect(() => {
    if (!cacheKey) return;
    const tick = () => {
      if (AppState.currentState !== "active") return;
      refresh().catch(() => undefined);
    };
    const interval = setInterval(tick, WORK_AREA_POLL_MS);
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      tick();
      refreshUserLocation();
    });
    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
  }, [cacheKey, refresh, refreshUserLocation]);

  async function handleRefresh() {
    setIsRefreshing(true);
    await refresh().catch(() => undefined);
    refreshUserLocation();
    setIsRefreshing(false);
  }

  const selectedSite = isField
    ? workLocations.find((site) => site.id === selectedSiteId) ?? workLocations[0] ?? null
    : workLocation;

  const mapState: MapState | null = selectedSite
    ? {
        site: {
          name: selectedSite.name,
          lat: Number(selectedSite.latitude),
          lon: Number(selectedSite.longitude),
          radius: Number(selectedSite.radiusMeters),
          boundary: isPolygonArea(selectedSite) ? selectedSite.boundary! : null,
        },
        user: userLocation ? { lat: userLocation.latitude, lon: userLocation.longitude } : null,
      }
    : null;
  const mapStateJson = mapState ? toScriptJson(mapState) : null;

  // The HTML is built once from the first state and then left alone — a new
  // `source` would reload the page (blank flash, lost zoom). Every later
  // change goes through applyMapState instead.
  const webViewRef = useRef<WebView | null>(null);
  const isMapReadyRef = useRef(false);
  const [mapHtml, setMapHtml] = useState<string | null>(null);
  useEffect(() => {
    if (mapState && mapHtml === null) setMapHtml(buildMapHtml(mapState));
  }, [mapStateJson, mapHtml]);
  const mapSource = useMemo(() => (mapHtml ? { html: mapHtml } : null), [mapHtml]);

  const pushMapState = useCallback(() => {
    if (!isMapReadyRef.current || !mapStateJson) return;
    webViewRef.current?.injectJavaScript(
      `window.applyMapState && window.applyMapState(${mapStateJson}); true;`,
    );
  }, [mapStateJson]);

  useEffect(() => {
    pushMapState();
  }, [pushMapState]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1680D8" />
      </View>
    );
  }

  // Only when there's nothing at all to show — with a last known area on
  // screen, a failed refresh stays silent and the poll keeps retrying.
  if (error && area === null) {
    return (
      <View style={styles.centered}>
        <EmptyState icon="warning-outline" title={error.message || "Failed to load your work area."} />
      </View>
    );
  }

  if (isField && workLocations.length === 0) {
    return (
      <AestheticScrollView
        contentContainerStyle={styles.centered}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      >
        <EmptyState
          icon="location-outline"
          title="No client/work sites have been assigned to you yet."
          message="Contact your supervisor if you believe this is a mistake."
        />
      </AestheticScrollView>
    );
  }

  if (!isField && !workLocation) {
    return (
      <AestheticScrollView
        contentContainerStyle={styles.centered}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      >
        <EmptyState
          icon="location-outline"
          title="No geotagged work area has been assigned to you yet."
          message="Contact HR if you believe this is a mistake."
        />
      </AestheticScrollView>
    );
  }

  const distance =
    userLocation != null && selectedSite != null
      ? distanceInMeters(
          userLocation.latitude,
          userLocation.longitude,
          Number(selectedSite.latitude),
          Number(selectedSite.longitude),
        )
      : null;
  const outsideBy =
    userLocation != null && selectedSite != null
      ? distanceOutsideGeofence(userLocation.latitude, userLocation.longitude, selectedSite)
      : null;
  const isPolygon = selectedSite != null && isPolygonArea(selectedSite);
  const isInside = outsideBy != null && outsideBy <= 0;
  // Inside, the headline number is "how far from the pin" (small = well
  // within range); outside, it's more useful as "how far past the fence"
  // than the raw distance from a centre point you're nowhere near. A
  // polygon has no meaningful centre, so inside it's "how far in from the
  // nearest edge" instead.
  const heroDistance =
    distance != null && outsideBy != null
      ? Math.round(isInside && !isPolygon ? distance : Math.abs(outsideBy))
      : null;

  return (
    <View style={styles.container}>
      {isField && (
        <AestheticScrollView
          horizontal
          style={styles.siteChipRow}
          contentContainerStyle={styles.siteChipRowContent}
        >
          {workLocations.map((site) => {
            const isSelected = site.id === selectedSite?.id;
            return (
              <Pressable
                key={site.id}
                onPress={() => setSelectedSiteId(site.id)}
                style={[styles.siteChip, isSelected && styles.siteChipActive]}
              >
                <Text style={[styles.siteChipText, isSelected && styles.siteChipTextActive]}>{site.name}</Text>
              </Pressable>
            );
          })}
        </AestheticScrollView>
      )}

      {selectedSite && (
        <>
          <View style={styles.card}>
            <View
              style={[
                styles.cardAccent,
                distance != null && (isInside ? styles.cardAccentIn : styles.cardAccentOut),
              ]}
            />
            <View style={styles.cardInner}>
              <Text style={styles.cardEyebrow}>WORK AREA</Text>

              <View style={styles.cardTopRow}>
                <View
                  style={[
                    styles.siteIconWrap,
                    distance != null && (isInside ? styles.siteIconWrapIn : styles.siteIconWrapOut),
                  ]}
                >
                  <Ionicons
                    name="location"
                    size={20}
                    color={distance == null ? "#1680D8" : isInside ? "#17A34A" : "#DC2626"}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{selectedSite.name}</Text>
                  <Text style={styles.cardSubtitle}>
                    {isPolygon ? "Authorized area: polygon" : `Authorized radius: ${Number(selectedSite.radiusMeters)}m`}
                  </Text>
                </View>
                {distance != null && (
                  <View style={[styles.statusBadge, { backgroundColor: isInside ? "#ECFDF3" : "#FEF2F2" }]}>
                    <Ionicons
                      name={isInside ? "checkmark-circle" : "alert-circle"}
                      size={13}
                      color={isInside ? "#17A34A" : "#DC2626"}
                    />
                    <Text style={[styles.statusBadgeText, { color: isInside ? "#15803D" : "#B91C1C" }]}>
                      {isInside ? "In range" : "Out of range"}
                    </Text>
                  </View>
                )}
              </View>

              {heroDistance != null && (
                <>
                  <View style={styles.cardDivider} />
                  <View style={styles.distanceBlock}>
                    <Text style={styles.distanceValue}>
                      {Math.abs(heroDistance)}
                      <Text style={styles.distanceUnit}> m</Text>
                    </Text>
                    <Text style={styles.distanceLabel}>
                      {isInside
                        ? isPolygon
                          ? "from the boundary — inside the work area"
                          : "from centre — inside the work area"
                        : "beyond the boundary"}
                    </Text>
                  </View>
                </>
              )}
            </View>
          </View>

          <View style={styles.mapWrapper}>
            {mapSource && (
              <WebView
                ref={(instance) => {
                  webViewRef.current = instance;
                }}
                originWhitelist={["*"]}
                source={mapSource}
                cacheMode={MAP_WEBVIEW_CACHE_MODE}
                style={styles.map}
                onLoadStart={() => {
                  isMapReadyRef.current = false;
                }}
                onLoadEnd={() => {
                  // Catch up on anything that changed while the page loaded.
                  isMapReadyRef.current = true;
                  pushMapState();
                }}
              />
            )}
          </View>

          <View style={styles.mapLegendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: "#1680D8" }]} />
              <Text style={styles.legendText}>Work area</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: "#17A34A" }]} />
              <Text style={styles.legendText}>Your location</Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

// Floating shadow — same treatment as LeaveScreen.tsx's/DTRScreen.tsx's
// cards, so cards read consistently across the app's employee-facing
// screens.
const cardShadow = {
  shadowColor: "#062B59",
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.12,
  shadowRadius: 16,
  elevation: 6,
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  siteChipRow: {
    flexGrow: 0,
    height: 48,
    marginBottom: 12,
  },
  siteChipRowContent: {
    alignItems: "center",
    gap: 8,
  },
  siteChip: {
    height: 40,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "#F1F5F9",
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  siteChipActive: {
    backgroundColor: "#062B59",
    borderColor: "#062B59",
  },
  siteChipText: {
    color: "#475569",
    fontSize: 13,
    lineHeight: 18,
    includeFontPadding: false,
    fontWeight: "700",
  },
  siteChipTextActive: {
    color: "#FFFFFF",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    marginBottom: 12,
    overflow: "hidden",
    ...cardShadow,
  },
  // Thin status strip across the top of the card — neutral blue until a GPS
  // fix lands, then reacts to in/out-of-range like the icon badge below it.
  cardAccent: {
    height: 4,
    backgroundColor: "#1680D8",
  },
  cardAccentIn: { backgroundColor: "#17A34A" },
  cardAccentOut: { backgroundColor: "#DC2626" },
  cardInner: {
    padding: 14,
  },
  cardEyebrow: {
    fontSize: 10.5,
    fontWeight: "700",
    color: "#94A3B8",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  siteIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  siteIconWrapIn: { backgroundColor: "#ECFDF3" },
  siteIconWrapOut: { backgroundColor: "#FEF2F2" },
  cardTitle: {
    color: "#062B59",
    fontSize: 16,
    fontWeight: "700",
  },
  cardSubtitle: {
    color: "#64748B",
    fontSize: 12.5,
    marginTop: 2,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  cardDivider: {
    height: 1,
    backgroundColor: "#F1F5F9",
    marginVertical: 12,
  },
  distanceBlock: {
    alignItems: "center",
  },
  distanceValue: {
    fontSize: 34,
    fontWeight: "800",
    color: "#062B59",
    letterSpacing: -0.5,
  },
  distanceUnit: {
    fontSize: 16,
    fontWeight: "700",
    color: "#64748B",
  },
  distanceLabel: {
    fontSize: 12.5,
    color: "#64748B",
    marginTop: 2,
  },
  mapWrapper: {
    flex: 1,
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    ...cardShadow,
  },
  map: {
    flex: 1,
  },
  mapLegendRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
    marginTop: 10,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
  },
  legendText: {
    fontSize: 11,
    color: "#64748B",
    fontWeight: "600",
  },
});
