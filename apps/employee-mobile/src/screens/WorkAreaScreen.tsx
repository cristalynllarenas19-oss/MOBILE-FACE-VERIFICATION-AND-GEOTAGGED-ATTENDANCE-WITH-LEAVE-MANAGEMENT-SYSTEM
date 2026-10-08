import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, RefreshControl, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import { WorkLocation, getMyWorkLocation, getMyWorkLocations } from "../api";
import { CACHE_KEYS, cacheGet, cacheSet } from "../utils/dataCache";
import { distanceInMeters } from "../utils/geofence";
import AestheticScrollView from "../components/AestheticScrollView";
import EmptyState from "../components/EmptyState";

type Props = {
  employeeId?: string;
  attendanceMode?: string;
};

function buildMapHtml(location: WorkLocation, userLat: number | null, userLon: number | null) {
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  const radius = Number(location.radiusMeters);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
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
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([${lat}, ${lon}], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // No shadowUrl — Leaflet's default drop-shadow is a skewed, hard-edged
    // shape that doesn't sit under the pin the way a shadow normally would,
    // which read as "the pointer isn't aligned" (mirrors admin-web's
    // WorkAreaPage.tsx). A plain pin reads cleaner.
    const siteIcon = L.icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
    });

    L.marker([${lat}, ${lon}], { icon: siteIcon }).addTo(map).bindPopup(
      '<div class="site-popup-title">' + ${JSON.stringify(location.name)} + '</div><div class="site-popup-meta">Radius: ${radius}m</div>',
      // minWidth stops a short name (e.g. "SLC") from shrinking the whole
      // bubble down to it — "Radius: 120m" then has nowhere to go but
      // wrap/overlap the close button. Not so wide that it dwarfs the map.
      { className: 'site-popup', minWidth: 130 }
    );
    L.circle([${lat}, ${lon}], { radius: ${radius}, color: '#1680D8', fillColor: '#1680D8', fillOpacity: 0.15 }).addTo(map);

    ${
      userLat !== null && userLon !== null
        ? `
    const userMarker = L.circleMarker([${userLat}, ${userLon}], {
      radius: 8, color: '#FFFFFF', weight: 2, fillColor: '#17A34A', fillOpacity: 1
    }).addTo(map).bindPopup('You are here', { className: 'you-popup' });
    const bounds = L.latLngBounds([[${lat}, ${lon}], [${userLat}, ${userLon}]]);
    map.fitBounds(bounds, { padding: [40, 40] });
    `
        : ""
    }
  </script>
</body>
</html>`;
}

export default function WorkAreaScreen({ employeeId, attendanceMode }: Props) {
  const isField = attendanceMode === "FIELD";
  const cacheKey = employeeId ? CACHE_KEYS.workArea(employeeId, isField ? "field" : "fixed") : null;
  const cachedArea = cacheKey ? cacheGet<WorkLocation[] | WorkLocation | null>(cacheKey) : null;
  const hasInitialCachedArea = cachedArea !== null;

  const [workLocation, setWorkLocation] = useState<WorkLocation | null>(
    () => (!isField && cachedArea && !Array.isArray(cachedArea) ? cachedArea : null),
  );
  const [workLocations, setWorkLocations] = useState<WorkLocation[]>(
    () => (isField && Array.isArray(cachedArea) ? cachedArea : []),
  );
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(
    () => (isField && Array.isArray(cachedArea) ? cachedArea[0]?.id ?? null : null),
  );
  const [userLocation, setUserLocation] = useState<Location.LocationObjectCoords | null>(null);
  const [isLoading, setIsLoading] = useState(!hasInitialCachedArea);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (cacheKey) {
        const cached = cacheGet<WorkLocation[] | WorkLocation | null>(cacheKey);
        if (isField && Array.isArray(cached)) {
          setWorkLocations(cached);
          setSelectedSiteId((current) => (current && cached.some((s) => s.id === current) ? current : cached[0]?.id ?? null));
        } else if (!isField && cached && !Array.isArray(cached)) {
          setWorkLocation(cached);
        }
      }

      const locations = await (isField ? getMyWorkLocations() : getMyWorkLocation());

      if (isField) {
        const sites = locations as WorkLocation[];
        setWorkLocations(sites);
        setSelectedSiteId((current) => (current && sites.some((s) => s.id === current) ? current : sites[0]?.id ?? null));
        if (cacheKey) cacheSet(cacheKey, sites);
      } else {
        const site = locations as WorkLocation | null;
        setWorkLocation(site);
        if (cacheKey) cacheSet(cacheKey, site);
      }
      // GPS is useful for the distance badge, not for rendering the assigned
      // work area. Load it in the background so the map is never held up.
      void Location.requestForegroundPermissionsAsync()
        .then((permission) => permission.granted
          ? Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
          : null)
        .then((position) => position && setUserLocation(position.coords))
        .catch(() => undefined);
    } catch (err) {
      if (!cacheKey || cacheGet<WorkLocation[] | WorkLocation | null>(cacheKey) === null) {
        setError(err instanceof Error ? err.message : "Failed to load your work area.");
      }
    }
  }, [cacheKey, isField]);

  useEffect(() => {
    const cached = cacheKey ? cacheGet<WorkLocation[] | WorkLocation | null>(cacheKey) : null;
    setIsLoading(cached === null);
    load().finally(() => setIsLoading(false));
  }, [cacheKey, load]);

  async function handleRefresh() {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1680D8" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <EmptyState icon="warning-outline" title={error} />
      </View>
    );
  }

  const selectedSite = isField ? workLocations.find((site) => site.id === selectedSiteId) ?? null : workLocation;

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
  const isInside = distance != null && selectedSite != null && distance <= Number(selectedSite.radiusMeters);
  // Inside, the headline number is "how far from the pin" (small = well
  // within range); outside, it's more useful as "how far past the fence"
  // than the raw distance from a centre point you're nowhere near.
  const heroDistance =
    distance != null && selectedSite != null
      ? Math.round(isInside ? distance : distance - Number(selectedSite.radiusMeters))
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
            const isSelected = site.id === selectedSiteId;
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
                  <Text style={styles.cardSubtitle}>Authorized radius: {Number(selectedSite.radiusMeters)}m</Text>
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
                      {isInside ? "from centre — inside the work area" : "beyond the boundary"}
                    </Text>
                  </View>
                </>
              )}
            </View>
          </View>

          <View style={styles.mapWrapper}>
            <WebView
              originWhitelist={["*"]}
              source={{ html: buildMapHtml(selectedSite, userLocation?.latitude ?? null, userLocation?.longitude ?? null) }}
              style={styles.map}
            />
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

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
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
    borderRadius: 16,
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
    borderRadius: 16,
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
