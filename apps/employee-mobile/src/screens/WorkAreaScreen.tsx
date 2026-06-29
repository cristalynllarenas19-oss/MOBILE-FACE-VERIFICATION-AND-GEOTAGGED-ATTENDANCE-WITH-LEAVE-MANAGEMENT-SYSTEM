import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, RefreshControl, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import { WorkLocation, getMyWorkLocation, getMyWorkLocations } from "../api";
import { distanceInMeters } from "../utils/geofence";

type Props = {
  employeeId?: string;
  attendanceMode?: "FIXED" | "FIELD";
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

    L.marker([${lat}, ${lon}]).addTo(map).bindPopup(${JSON.stringify(location.name)});
    L.circle([${lat}, ${lon}], { radius: ${radius}, color: '#1680D8', fillColor: '#1680D8', fillOpacity: 0.15 }).addTo(map);

    ${
      userLat !== null && userLon !== null
        ? `
    const userMarker = L.circleMarker([${userLat}, ${userLon}], {
      radius: 8, color: '#DC2626', fillColor: '#DC2626', fillOpacity: 0.9
    }).addTo(map).bindPopup('You are here');
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

  const [workLocation, setWorkLocation] = useState<WorkLocation | null>(null);
  const [workLocations, setWorkLocations] = useState<WorkLocation[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<Location.LocationObjectCoords | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [locations, permission] = await Promise.all([
        isField ? getMyWorkLocations() : getMyWorkLocation(),
        Location.requestForegroundPermissionsAsync(),
      ]);

      if (isField) {
        const sites = locations as WorkLocation[];
        setWorkLocations(sites);
        setSelectedSiteId((current) => (current && sites.some((s) => s.id === current) ? current : sites[0]?.id ?? null));
      } else {
        setWorkLocation(locations as WorkLocation | null);
      }

      if (permission.granted) {
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setUserLocation(position.coords);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load your work area.");
    }
  }, [isField]);

  useEffect(() => {
    setIsLoading(true);
    load().finally(() => setIsLoading(false));
  }, [load]);

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
        <Ionicons name="warning-outline" size={36} color="#DC2626" />
        <Text style={styles.emptyText}>{error}</Text>
      </View>
    );
  }

  const selectedSite = isField ? workLocations.find((site) => site.id === selectedSiteId) ?? null : workLocation;

  if (isField && workLocations.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.centered}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      >
        <Ionicons name="location-outline" size={36} color="#94A3B8" />
        <Text style={styles.emptyText}>No client/work sites have been assigned to you yet.</Text>
        <Text style={styles.emptySubText}>Contact your supervisor if you believe this is a mistake.</Text>
      </ScrollView>
    );
  }

  if (!isField && !workLocation) {
    return (
      <ScrollView
        contentContainerStyle={styles.centered}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={["#1680D8"]} />}
      >
        <Ionicons name="location-outline" size={36} color="#94A3B8" />
        <Text style={styles.emptyText}>No geotagged work area has been assigned to you yet.</Text>
        <Text style={styles.emptySubText}>Contact HR if you believe this is a mistake.</Text>
      </ScrollView>
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

  return (
    <View style={styles.container}>
      {isField && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.siteChipRow} contentContainerStyle={{ gap: 8 }}>
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
        </ScrollView>
      )}

      {selectedSite && (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{selectedSite.name}</Text>
            <Text style={styles.cardSubtitle}>Authorized radius: {Number(selectedSite.radiusMeters)}m</Text>
          </View>

          {distance != null && (
            <View style={[styles.banner, { backgroundColor: isInside ? "#ECFDF3" : "#FEF2F2" }]}>
              <Ionicons
                name={isInside ? "checkmark-circle" : "alert-circle"}
                size={20}
                color={isInside ? "#17A34A" : "#DC2626"}
              />
              <Text style={[styles.bannerText, { color: isInside ? "#15803D" : "#B91C1C" }]}>
                {isInside
                  ? `You are ${Math.round(distance)}m away — inside this site's work area.`
                  : `You are ${Math.round(distance)}m away — outside this site's work area.`}
              </Text>
            </View>
          )}

          <View style={styles.mapWrapper}>
            <WebView
              originWhitelist={["*"]}
              source={{ html: buildMapHtml(selectedSite, userLocation?.latitude ?? null, userLocation?.longitude ?? null) }}
              style={styles.map}
            />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
  },
  siteChipRow: {
    flexGrow: 0,
    marginBottom: 12,
  },
  siteChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
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
    fontWeight: "700",
  },
  siteChipTextActive: {
    color: "#FFFFFF",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    marginBottom: 12,
  },
  cardTitle: {
    color: "#062B59",
    fontSize: 17,
    fontWeight: "700",
  },
  cardSubtitle: {
    color: "#64748B",
    fontSize: 13,
    marginTop: 4,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
  },
  mapWrapper: {
    flex: 1,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  map: {
    flex: 1,
  },
  emptyText: {
    color: "#475569",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  emptySubText: {
    color: "#94A3B8",
    fontSize: 12,
    textAlign: "center",
  },
});
