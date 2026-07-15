import React, { useCallback, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, RefreshControl, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import EmptyState from "../../components/EmptyState";
import Avatar from "../../components/Avatar";
import {
  GeotaggedLocation,
  TeamEmployee,
  getGeotaggedLocations,
  getTeamEmployees,
  assignEmployeeToLocation,
  unassignEmployeeFromLocation,
} from "../../api";
import { useCachedData } from "../../utils/dataCache";

type Props = {
  onClose: () => void;
};

// Falls back to the org's home office area when a Supervisor has no
// geotagged locations yet, so the map still renders somewhere sensible
// instead of the ocean at (0, 0).
const FALLBACK_CENTER = { lat: 16.3222, lon: 120.3656 };

function buildAreasMapHtml(locations: GeotaggedLocation[]) {
  const points = locations.map((location) => ({
    id: location.id,
    name: location.name,
    lat: Number(location.latitude),
    lon: Number(location.longitude),
    radius: Number(location.radiusMeters),
    count: location.employees?.length ?? 0,
  }));

  const center = points[0] ?? { lat: FALLBACK_CENTER.lat, lon: FALLBACK_CENTER.lon };

  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; }
    .area-popup { font-family: -apple-system, Roboto, sans-serif; }
    .area-popup b { color: #062B59; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map', { zoomControl: false }).setView([${center.lat}, ${center.lon}], 15);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const points = ${JSON.stringify(points)};
    const markers = {};

    points.forEach((p) => {
      const marker = L.marker([p.lat, p.lon]).addTo(map);
      marker.bindPopup('<div class="area-popup"><b>' + p.name + '</b><br/>' + p.count + ' employee(s) assigned</div>');
      marker.on('click', () => {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(p.id);
      });
      L.circle([p.lat, p.lon], { radius: p.radius, color: '#0EA5E9', fillColor: '#0EA5E9', fillOpacity: 0.15, weight: 1.5 }).addTo(map);
      markers[p.id] = marker;
    });

    if (points.length > 1) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
      map.fitBounds(bounds, { padding: [36, 36] });
    }

    window.flyTo = function(id) {
      const marker = markers[id];
      if (!marker) return;
      map.flyTo(marker.getLatLng(), 17, { duration: 0.6 });
      marker.openPopup();
    };
  </script>
</body>
</html>`;
}

// A Supervisor can only assign/unassign employees on an area that already
// exists — creating, editing, deleting, or activating/deactivating is
// HR/Admin-only, mirroring GeotaggingPage.tsx's canManageAreas gating and
// the identical guards enforced server-side in GeolocationController.
export default function GeotaggedAreasScreen({ onClose }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [managingLocation, setManagingLocation] = useState<GeotaggedLocation | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);
  const webViewRef = useRef<WebView | null>(null);

  const locationsCache = useCachedData<GeotaggedLocation[]>("geotagged-locations", getGeotaggedLocations);
  // Same cache key as TeamScreen — the roster is fetched once and shared.
  const employeesCache = useCachedData<TeamEmployee[]>("team-employees", getTeamEmployees);
  const locations = locationsCache.data ?? [];
  const employees = employeesCache.data ?? [];
  const isLoading = locationsCache.isLoading || employeesCache.isLoading;

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        await Promise.all([locationsCache.refresh(), employeesCache.refresh()]);
      } catch (error) {
        console.error("Failed to load geotagged areas", error);
      } finally {
        setIsRefreshing(false);
      }
    },
    [locationsCache.refresh, employeesCache.refresh],
  );

  function isAssigned(location: GeotaggedLocation, employeeId: string) {
    return Boolean(location.employees?.some((e) => e.employee.id === employeeId));
  }

  function selectLocation(location: GeotaggedLocation) {
    setManagingLocation(location);
    webViewRef.current?.injectJavaScript(`window.flyTo && window.flyTo(${JSON.stringify(location.id)}); true;`);
  }

  async function toggleAssignment(location: GeotaggedLocation, employeeId: string) {
    setIsSaving(true);
    try {
      const updated = isAssigned(location, employeeId)
        ? await unassignEmployeeFromLocation(location.id, employeeId)
        : await assignEmployeeToLocation(location.id, employeeId);
      setManagingLocation(updated);
      locationsCache.setData(locations.map((l) => (l.id === updated.id ? updated : l)));
    } catch (error) {
      setResultModal({ status: "error", title: "Update Failed", message: error instanceof Error ? error.message : "Failed to update assignment." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color="#062B59" />
        </Pressable>
        <Text style={styles.headerTitle}>Geotagged Areas</Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <>
          <View style={styles.mapWrapper}>
            <WebView
              ref={(instance) => {
                webViewRef.current = instance;
              }}
              originWhitelist={["*"]}
              source={{ html: buildAreasMapHtml(locations) }}
              style={styles.map}
              onMessage={(event) => {
                const id = event.nativeEvent.data;
                const location = locations.find((l) => l.id === id);
                if (location) setManagingLocation(location);
              }}
            />
            {locations.length === 0 && (
              <View style={styles.mapOverlay} pointerEvents="none">
                <Text style={styles.mapOverlayText}>No areas to show yet</Text>
              </View>
            )}
          </View>

          <ScrollView
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor="#062B59" />}
          >
            {locations.length === 0 ? (
              <EmptyState icon="location-outline" title="No geotagged areas" message="Areas for your department will appear here." />
            ) : (
              <>
                <Text style={styles.countLabel}>{locations.length} area{locations.length === 1 ? "" : "s"}</Text>
                {locations.map((location) => (
                  <Pressable
                    key={location.id}
                    style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                    onPress={() => selectLocation(location)}
                  >
                    <View style={styles.cardIconWrap}>
                      <Ionicons name="location" size={18} color="#0EA5E9" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>{location.name}</Text>
                      <Text style={styles.cardMeta}>{location.employees?.length ?? 0} employee(s) assigned · {Number(location.radiusMeters)}m radius</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        </>
      )}

      <Modal visible={!!managingLocation} transparent animationType="slide" onRequestClose={() => setManagingLocation(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>{managingLocation?.name}</Text>
            <Text style={styles.modalSubtitle}>Tap an employee to assign or unassign</Text>
            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
              {employees.map((employee) => {
                const assigned = managingLocation ? isAssigned(managingLocation, employee.id) : false;
                return (
                  <Pressable
                    key={employee.id}
                    style={({ pressed }) => [styles.employeeRow, pressed && styles.employeeRowPressed]}
                    disabled={isSaving}
                    onPress={() => managingLocation && toggleAssignment(managingLocation, employee.id)}
                  >
                    <Avatar firstName={employee.firstName} lastName={employee.lastName} size={34} />
                    <Text style={styles.employeeRowText}>{employee.firstName} {employee.lastName}</Text>
                    <Ionicons name={assigned ? "checkmark-circle" : "add-circle-outline"} size={22} color={assigned ? "#15803D" : "#94A3B8"} />
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable style={styles.closeButton} onPress={() => setManagingLocation(null)}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ResultModal
        visible={!!resultModal}
        status={resultModal?.status ?? "info"}
        title={resultModal?.title ?? ""}
        message={resultModal?.message ?? ""}
        onClose={() => setResultModal(null)}
      />
    </SafeAreaView>
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
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  headerTitle: { fontSize: 16, fontWeight: "700", color: "#062B59" },
  mapWrapper: {
    height: 220,
    borderRadius: 18,
    overflow: "hidden",
    marginBottom: 14,
    ...cardShadow,
  },
  map: { flex: 1 },
  mapOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(248,250,252,0.85)" },
  mapOverlayText: { fontSize: 12, color: "#94A3B8", fontWeight: "600" },
  countLabel: { fontSize: 12, color: "#94A3B8", fontWeight: "600", marginBottom: 2 },
  list: { paddingBottom: 24, gap: 10 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#FFFFFF", borderRadius: 16, padding: 14, ...cardShadow },
  cardPressed: { opacity: 0.85 },
  cardIconWrap: { width: 38, height: 38, borderRadius: 12, backgroundColor: "#E0F2FE", alignItems: "center", justifyContent: "center" },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#062B59" },
  cardMeta: { fontSize: 12, color: "#64748B", marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalCard: { maxHeight: "80%", backgroundColor: "#FFFFFF", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingTop: 12 },
  modalHandle: { width: 40, height: 4, borderRadius: 999, backgroundColor: "#E2E8F0", alignSelf: "center", marginBottom: 14 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#062B59" },
  modalSubtitle: { fontSize: 12, color: "#64748B", marginTop: 2, marginBottom: 10 },
  employeeRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 4, borderRadius: 12 },
  employeeRowPressed: { backgroundColor: "#F8FAFC" },
  employeeRowText: { flex: 1, fontSize: 14, color: "#334155", fontWeight: "600" },
  closeButton: { marginTop: 14, height: 48, borderRadius: 14, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  closeText: { color: "#FFFFFF", fontWeight: "700" },
});
