import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
  Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import ResultModal, { ResultModalStatus } from "../../components/ResultModal";
import Avatar from "../../components/Avatar";
import AestheticScrollView from "../../components/AestheticScrollView";
import SegmentedControl from "../../components/SegmentedControl";
import {
  GeotaggedLocation,
  TeamEmployee,
  getGeotaggedLocations,
  getTeamEmployees,
  assignEmployeeToLocation,
  unassignEmployeeFromLocation,
} from "../../api";
import { useCachedData } from "../../utils/dataCache";
import { describeGeofence, isPolygonArea } from "../../utils/geofence";
import { MAP_WEBVIEW_CACHE_MODE, OSM_TILE_URL, leafletHeadHtml } from "../../utils/leafletHtml";
import { ui } from "../../styles/ui";

type Props = {
  onClose: () => void;
};

// Falls back to the org's home office area when a Supervisor has no
// geotagged locations yet, so the map still renders somewhere sensible
// instead of the ocean at (0, 0).
const FALLBACK_CENTER = { lat: 16.3222, lon: 120.3656 };

// The area assignDefaultOfficeLocation() matches on by name — pinned first
// in the list, same as admin-web's GeotaggingPage does.
const DEFAULT_OFFICE_NAME = "Universal Leaf Philippines Inc. - Agoo";

type AreaStatusFilter = "all" | "active" | "inactive";
type EmployeeModeFilter = "ALL" | "FIELD" | "NON_FIELD";

function isGlobalZoneLocation(location?: GeotaggedLocation | null) {
  return Boolean(location?.name && location.name.toLowerCase().includes("global zone"));
}

function isDefaultOfficeLocation(location?: GeotaggedLocation | null) {
  return location?.name === DEFAULT_OFFICE_NAME;
}

function buildAreasMapHtml(locations: GeotaggedLocation[]) {
  const points = locations.map((location) => ({
    id: location.id,
    name: location.name,
    lat: Number(location.latitude),
    lon: Number(location.longitude),
    radius: Number(location.radiusMeters),
    boundary: isPolygonArea(location) ? location.boundary : null,
    count: location.employees?.length ?? 0,
  }));

  const center = points[0] ?? { lat: FALLBACK_CENTER.lat, lon: FALLBACK_CENTER.lon };

  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  ${leafletHeadHtml()}
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; }
    .area-popup { font-family: -apple-system, Roboto, sans-serif; }
    .area-popup b { color: #062B59; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const map = L.map('map', { zoomControl: false }).setView([${center.lat}, ${center.lon}], 15);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('${OSM_TILE_URL}', {
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
      const areaStyle = { color: '#0EA5E9', fillColor: '#0EA5E9', fillOpacity: 0.15, weight: 1.5 };
      (p.boundary
        // One polygon per part — a plain list of rings would draw every
        // part after the first as a hole.
        ? L.polygon(p.boundary.map((ring) => [ring]), areaStyle)
        : L.circle([p.lat, p.lon], Object.assign({ radius: p.radius }, areaStyle))
      ).addTo(map);
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
  const [managingLocationId, setManagingLocationId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resultModal, setResultModal] = useState<{ status: ResultModalStatus; title: string; message: string } | null>(null);
  const [areaStatusFilter, setAreaStatusFilter] = useState<AreaStatusFilter>("active");
  const [areaSearchQuery, setAreaSearchQuery] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employeeModeFilter, setEmployeeModeFilter] = useState<EmployeeModeFilter>("ALL");
  // The map is reference material; the list of areas to assign is the job.
  // So it stays folded away until asked for, and the list gets the screen.
  const [isMapVisible, setIsMapVisible] = useState(false);
  const webViewRef = useRef<WebView | null>(null);

  const locationsCache = useCachedData<GeotaggedLocation[]>("geotagged-locations", getGeotaggedLocations);
  // Same cache key as TeamScreen — the roster is fetched once and shared.
  const employeesCache = useCachedData<TeamEmployee[]>("team-employees", getTeamEmployees);
  const locations = locationsCache.data ?? [];
  const employees = employeesCache.data ?? [];
  const isLoading = locationsCache.isLoading || employeesCache.isLoading;

  // A new `source` object reloads the whole WebView (re-parse Leaflet,
  // re-fetch tiles, lose zoom), so it must only change when the map content
  // does — not on every keystroke in the search boxes or filter tap. Keyed on
  // the HTML string itself so a background refresh with identical data
  // doesn't reload it either.
  const mapHtml = useMemo(() => buildAreasMapHtml(locationsCache.data ?? []), [locationsCache.data]);
  const mapSource = useMemo(() => ({ html: mapHtml }), [mapHtml]);

  const managingLocation = useMemo(
    () => locations.find((location) => location.id === managingLocationId) ?? null,
    [locations, managingLocationId],
  );

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

  // Cross-referenced against the active roster rather than trusting each
  // location's embedded assignment rows — an archived employee's
  // WorkLocationEmployee row can outlive their archive and would otherwise
  // inflate this count past the real active headcount (the same rule
  // admin-web's "Assigned Employees" stat uses).
  const activeEmployeeIds = useMemo(() => new Set(employees.map((employee) => employee.id)), [employees]);

  const assignedEmployees = useMemo(
    () =>
      new Set(
        locations
          .flatMap((location) => location.employees?.map((entry) => entry.employee.id) ?? [])
          .filter((employeeId) => activeEmployeeIds.has(employeeId)),
      ),
    [locations, activeEmployeeIds],
  );

  const activeAreaCount = locations.filter((location) => location.isActive !== false).length;
  const inactiveAreaCount = locations.filter((location) => location.isActive === false).length;

  const filteredLocations = useMemo(() => {
    const query = areaSearchQuery.trim().toLowerCase();
    return locations
      .filter((location) => {
        const isActive = location.isActive !== false;
        if (areaStatusFilter === "active" && !isActive) return false;
        if (areaStatusFilter === "inactive" && isActive) return false;
        if (!query) return true;
        return location.name.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        // Office areas above Field areas, and the canonical default office
        // first within them — the same order admin-web lists them in, so an
        // area sits in the same place in both apps.
        const aOffice = a.type === "OFFICE";
        const bOffice = b.type === "OFFICE";
        if (aOffice !== bOffice) return aOffice ? -1 : 1;
        const aDefault = isDefaultOfficeLocation(a);
        const bDefault = isDefaultOfficeLocation(b);
        if (aDefault !== bDefault) return aDefault ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [areaSearchQuery, areaStatusFilter, locations]);

  const areaEmptyMessage = areaSearchQuery.trim()
    ? "No areas match your search. Try a different area name."
    : areaStatusFilter === "inactive"
      ? "No inactive areas. Deactivated areas will show up here."
      : areaStatusFilter === "active"
        ? "No active areas."
        : "No areas match this filter.";

  function getLocationEmployees(location: GeotaggedLocation) {
    return location.employees?.map((entry) => entry.employee) ?? [];
  }

  function isAssigned(location: GeotaggedLocation, employeeId: string) {
    return Boolean(location.employees?.some((e) => e.employee.id === employeeId));
  }

  const managingIsGlobalZone = isGlobalZoneLocation(managingLocation);

  // Field areas are reserved for employees whose department is Field or
  // Both — a Fixed department is office-only. The backend enforces this too
  // (GeolocationService.assertFieldAreaRoster); this just locks the row.
  const isBlockedFromFieldArea = (employee: TeamEmployee) =>
    managingLocation?.type === "FIELD" && employee.department?.attendanceMode === "FIXED";

  const employeeRowsBeforeModeFilter = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    return employees
      .filter((employee) => {
        if (!query) return true;
        return `${employee.firstName} ${employee.lastName}`.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        // Assigned to this area first, then everyone still assignable, then
        // the greyed-out "already assigned to another area" rows last — so
        // the pickable employees are never buried.
        const rank = (employee: TeamEmployee) => {
          if (managingLocation && isAssigned(managingLocation, employee.id)) return 0;
          const isAssignedElsewhere = assignedEmployees.has(employee.id) && employee.attendanceMode !== "FIELD";
          return isAssignedElsewhere || isBlockedFromFieldArea(employee) ? 2 : 1;
        };
        const rankDiff = rank(a) - rank(b);
        if (rankDiff !== 0) return rankDiff;
        return `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
      });
  }, [assignedEmployees, employeeSearch, employees, managingLocation]);

  const employeeModeCounts = useMemo(
    () => ({
      ALL: employeeRowsBeforeModeFilter.length,
      FIELD: employeeRowsBeforeModeFilter.filter((employee) => employee.attendanceMode === "FIELD").length,
      NON_FIELD: employeeRowsBeforeModeFilter.filter((employee) => employee.attendanceMode !== "FIELD").length,
    }),
    [employeeRowsBeforeModeFilter],
  );

  const employeeRows = useMemo(() => {
    if (employeeModeFilter === "ALL") return employeeRowsBeforeModeFilter;
    return employeeRowsBeforeModeFilter.filter((employee) =>
      employeeModeFilter === "FIELD" ? employee.attendanceMode === "FIELD" : employee.attendanceMode !== "FIELD",
    );
  }, [employeeModeFilter, employeeRowsBeforeModeFilter]);

  // Rows in the current filtered list that can be toggled: assigned here,
  // assigned nowhere, or a Field employee (who may cover many sites).
  const selectableEmployeeIds = useMemo(() => {
    if (!managingLocation) return [] as string[];
    return employeeRows
      .filter(
        (employee) =>
          isAssigned(managingLocation, employee.id) ||
          (!isBlockedFromFieldArea(employee) &&
            (!assignedEmployees.has(employee.id) || employee.attendanceMode === "FIELD")),
      )
      .map((employee) => employee.id);
  }, [assignedEmployees, employeeRows, managingLocation]);

  const allSelectableSelected =
    !!managingLocation &&
    selectableEmployeeIds.length > 0 &&
    selectableEmployeeIds.every((id) => isAssigned(managingLocation, id));

  function selectLocation(location: GeotaggedLocation) {
    setManagingLocationId(location.id);
    setEmployeeSearch("");
    setEmployeeModeFilter("ALL");
    webViewRef.current?.injectJavaScript(`window.flyTo && window.flyTo(${JSON.stringify(location.id)}); true;`);
  }

  function applyUpdatedLocation(updated: GeotaggedLocation) {
    locationsCache.setData(locations.map((l) => (l.id === updated.id ? updated : l)));
  }

  async function toggleAssignment(location: GeotaggedLocation, employeeId: string) {
    setIsSaving(true);
    try {
      const updated = isAssigned(location, employeeId)
        ? await unassignEmployeeFromLocation(location.id, employeeId)
        : await assignEmployeeToLocation(location.id, employeeId);
      applyUpdatedLocation(updated);
    } catch (error) {
      setResultModal({
        status: "error",
        title: "Update Failed",
        message: error instanceof Error ? error.message : "Failed to update assignment.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  // Select All / Unselect All on the rows currently in view. Each employee
  // is its own request (the per-employee endpoints are the only ones a
  // Supervisor may call), so whatever succeeded before a failure is kept.
  async function toggleSelectAll(location: GeotaggedLocation) {
    if (managingIsGlobalZone || selectableEmployeeIds.length === 0) return;
    const unassigning = allSelectableSelected;
    const targets = selectableEmployeeIds.filter((id) => isAssigned(location, id) === unassigning);
    setIsSaving(true);
    let latest = location;
    try {
      for (const employeeId of targets) {
        latest = unassigning
          ? await unassignEmployeeFromLocation(location.id, employeeId)
          : await assignEmployeeToLocation(location.id, employeeId);
      }
    } catch (error) {
      setResultModal({
        status: "error",
        title: "Update Failed",
        message: error instanceof Error ? error.message : "Failed to update assignments.",
      });
    } finally {
      applyUpdatedLocation(latest);
      setIsSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} style={styles.backButton} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color="#062B59" />
        </Pressable>
        <Text style={styles.headerTitle}>Geotagged Areas</Text>
        <View style={styles.headerSpacer} />
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#062B59" size="large" />
        </View>
      ) : (
        <>
          <View style={ui.card}>
            <View style={ui.pinnedHeader}>
              <View style={styles.titleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.cardTitle}>Assign Employees</Text>
                  <Text style={ui.cardSubtitle} numberOfLines={1}>
                    {locations.length} zone{locations.length === 1 ? "" : "s"} · {assignedEmployees.size} of{" "}
                    {employees.length} employees assigned
                  </Text>
                </View>
                <Pressable
                  style={[styles.mapToggle, isMapVisible && styles.mapToggleActive]}
                  onPress={() => setIsMapVisible((visible) => !visible)}
                >
                  <Ionicons name="map-outline" size={14} color={isMapVisible ? "#FFFFFF" : "#062B59"} />
                  <Text style={[styles.mapToggleText, isMapVisible && styles.mapToggleTextActive]}>
                    {isMapVisible ? "Hide map" : "Map"}
                  </Text>
                </Pressable>
              </View>

              {isMapVisible && (
                <View style={styles.mapWrapper}>
                  <WebView
                    ref={(instance) => {
                      webViewRef.current = instance;
                    }}
                    originWhitelist={["*"]}
                    source={mapSource}
                    cacheMode={MAP_WEBVIEW_CACHE_MODE}
                    style={styles.map}
                    onMessage={(event) => {
                      const id = event.nativeEvent.data;
                      const location = locations.find((l) => l.id === id);
                      if (location) selectLocation(location);
                    }}
                  />
                  {locations.length === 0 && (
                    <View style={styles.mapOverlay} pointerEvents="none">
                      <Text style={styles.mapOverlayText}>No areas to show yet</Text>
                    </View>
                  )}
                </View>
              )}

              {/* All first, so the unfiltered list is the default reach. */}
              <SegmentedControl
                segments={[
                  { key: "all", label: `All · ${locations.length}` },
                  { key: "active", label: `Active · ${activeAreaCount}` },
                  { key: "inactive", label: `Inactive · ${inactiveAreaCount}` },
                ]}
                value={areaStatusFilter}
                onChange={(key) => setAreaStatusFilter(key as AreaStatusFilter)}
                style={ui.tabSwitcher}
                dense
              />

              <View style={ui.filterRow}>
                <View style={styles.searchBox}>
                  <Ionicons name="search-outline" size={16} color="#94A3B8" />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search areas..."
                    placeholderTextColor="#94A3B8"
                    value={areaSearchQuery}
                    onChangeText={setAreaSearchQuery}
                  />
                </View>
                {!!areaSearchQuery && (
                  <Pressable style={ui.iconButton} onPress={() => setAreaSearchQuery("")}>
                    <Ionicons name="close" size={16} color="#94A3B8" />
                  </Pressable>
                )}
              </View>
            </View>

            <AestheticScrollView
              style={ui.list}
              contentContainerStyle={ui.listContent}
              refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} colors={["#1680D8"]} />}
            >
              {locations.length === 0 ? (
                <View style={ui.emptyState}>
                  <Ionicons name="location-outline" size={36} color="#CBD5E1" />
                  <Text style={ui.emptyText}>Areas for your department will appear here.</Text>
                </View>
              ) : filteredLocations.length === 0 ? (
                <View style={ui.emptyState}>
                  <Ionicons name="search-outline" size={36} color="#CBD5E1" />
                  <Text style={ui.emptyText}>{areaEmptyMessage}</Text>
                </View>
              ) : (
                // A plain list, one row per area with a hairline between
                // them — no boxes inside the card. The row says where the
                // area is and shows the faces already on it; tapping it
                // opens the assign dialog.
                <View>
                  {filteredLocations.map((location, index) => {
                    const locationEmployees = getLocationEmployees(location);
                    const isGlobal = isGlobalZoneLocation(location);
                    const isActive = location.isActive !== false;
                    const shownFaces = locationEmployees.slice(0, 5);
                    const hiddenFaces = locationEmployees.length - shownFaces.length;

                    return (
                      <Pressable
                        key={location.id}
                        style={({ pressed }) => [
                          styles.areaRow,
                          index > 0 && styles.areaRowDivider,
                          pressed && styles.areaRowPressed,
                        ]}
                        onPress={() => selectLocation(location)}
                      >
                        <View style={[styles.areaIconWrap, !isActive && styles.areaIconWrapInactive]}>
                          <Ionicons name="location" size={18} color={isActive ? "#0EA5E9" : "#94A3B8"} />
                        </View>

                        <View style={styles.areaBody}>
                          <Text style={[styles.areaName, !isActive && styles.areaNameInactive]} numberOfLines={2}>
                            {location.name}
                          </Text>
                          <Text style={styles.areaMeta} numberOfLines={1}>
                            {location.type === "FIELD" ? "Field" : "Office"} · {describeGeofence(location)}
                            {isDefaultOfficeLocation(location) ? " · Default" : ""}
                            {!isActive ? " · Inactive" : ""}
                          </Text>

                          <View style={styles.facesRow}>
                            {isGlobal ? (
                              <Text style={styles.facesText}>Everyone is covered by this zone</Text>
                            ) : locationEmployees.length === 0 ? (
                              <Text style={styles.facesEmpty}>No one assigned yet</Text>
                            ) : (
                              <>
                                <View style={styles.faceStack}>
                                  {shownFaces.map((employee, faceIndex) => (
                                    <View
                                      key={employee.id}
                                      style={[styles.face, faceIndex > 0 && styles.faceOverlap]}
                                    >
                                      <Avatar firstName={employee.firstName} lastName={employee.lastName} size={24} />
                                    </View>
                                  ))}
                                </View>
                                <Text style={styles.facesText}>
                                  {hiddenFaces > 0 ? `+${hiddenFaces} · ` : ""}
                                  {locationEmployees.length} assigned
                                </Text>
                              </>
                            )}
                          </View>
                        </View>

                        <Ionicons name="chevron-forward" size={18} color="#CBD5E1" />
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </AestheticScrollView>
          </View>
        </>
      )}

      <Modal visible={!!managingLocation} transparent animationType="fade" onRequestClose={() => setManagingLocationId(null)}>
        <View style={ui.modalOverlay}>
          <View style={[ui.modalCard, styles.assignDialog]}>
            <View style={styles.dialogHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.dialogEyebrow}>Assign employees to</Text>
                <Text style={styles.dialogTitle} numberOfLines={2}>
                  {managingLocation?.name}
                </Text>
              </View>
              <View style={styles.dialogCount}>
                <Text style={styles.dialogCountValue}>
                  {managingLocation ? getLocationEmployees(managingLocation).length : 0}
                </Text>
                <Text style={styles.dialogCountLabel}>assigned</Text>
              </View>
            </View>
            {managingIsGlobalZone && (
              <Text style={styles.modalSubtitle}>
                Global Zone is remove-only. You can unassign employees here, but you cannot add new ones.
              </Text>
            )}

            {!managingIsGlobalZone && (
              <>
                <View style={ui.filterRow}>
                  <View style={styles.searchBox}>
                    <Ionicons name="search-outline" size={16} color="#94A3B8" />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Search employees"
                      placeholderTextColor="#94A3B8"
                      value={employeeSearch}
                      onChangeText={setEmployeeSearch}
                    />
                  </View>
                </View>

                <SegmentedControl
                  segments={[
                    { key: "ALL", label: `All · ${employeeModeCounts.ALL}` },
                    { key: "FIELD", label: `Field · ${employeeModeCounts.FIELD}` },
                    { key: "NON_FIELD", label: `Non-field · ${employeeModeCounts.NON_FIELD}` },
                  ]}
                  value={employeeModeFilter}
                  onChange={(key) => setEmployeeModeFilter(key as EmployeeModeFilter)}
                  style={ui.tabSwitcher}
                  dense
                />

                <Pressable
                  style={[styles.selectAllButton, selectableEmployeeIds.length === 0 && styles.selectAllDisabled]}
                  disabled={isSaving || selectableEmployeeIds.length === 0 || !managingLocation}
                  onPress={() => managingLocation && toggleSelectAll(managingLocation)}
                >
                  <Ionicons
                    name={allSelectableSelected ? "checkbox" : "square-outline"}
                    size={16}
                    color={allSelectableSelected ? "#062B59" : "#94A3B8"}
                  />
                  <Text style={styles.selectAllText}>
                    {allSelectableSelected ? "Unselect All" : "Select All"}
                    {selectableEmployeeIds.length > 0 ? ` (${selectableEmployeeIds.length})` : ""}
                  </Text>
                  {isSaving && <ActivityIndicator size="small" color="#062B59" />}
                </Pressable>
              </>
            )}

            <AestheticScrollView style={styles.dialogList}>
              {employeeRows.length === 0 ? (
                <View style={ui.emptyState}>
                  <Ionicons name="people-outline" size={32} color="#CBD5E1" />
                  <Text style={ui.emptyText}>No employees match your search.</Text>
                </View>
              ) : (
                employeeRows.map((employee) => {
                  const assigned = managingLocation ? isAssigned(managingLocation, employee.id) : false;
                  // Global Zone covers everyone, so only the rows that can
                  // still be removed are listed there.
                  if (managingIsGlobalZone && !assigned) return null;
                  // Someone already pinned to another area cannot be added
                  // here — unless they are a Field employee, who may cover
                  // many sites (the same rule GeotaggingPage.tsx enforces).
                  const isAssignedElsewhere =
                    assignedEmployees.has(employee.id) && !assigned && employee.attendanceMode !== "FIELD";
                  // Still shown (and removable) when already assigned.
                  const isFixedDepartmentOnField = !assigned && isBlockedFromFieldArea(employee);
                  const isLocked = isAssignedElsewhere || isFixedDepartmentOnField;

                  return (
                    <Pressable
                      key={employee.id}
                      style={({ pressed }) => [
                        styles.employeeRow,
                        assigned && styles.employeeRowAssigned,
                        pressed && !isLocked && styles.employeeRowPressed,
                        isLocked && styles.employeeRowDisabled,
                      ]}
                      disabled={isSaving || isLocked}
                      onPress={() => managingLocation && toggleAssignment(managingLocation, employee.id)}
                    >
                      <Avatar firstName={employee.firstName} lastName={employee.lastName} size={34} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.employeeName} numberOfLines={1}>
                          {employee.firstName} {employee.lastName}
                        </Text>
                        <Text style={styles.employeeMeta} numberOfLines={1}>
                          {employee.department?.name ?? "—"}
                          {employee.attendanceMode === "FIELD" ? " · Field" : ""}
                        </Text>
                        {isAssignedElsewhere && (
                          <Text style={styles.employeeNote}>Already assigned to another geotagged area</Text>
                        )}
                        {isFixedDepartmentOnField && (
                          <Text style={styles.employeeNote}>
                            Fixed department — only Field or Both departments can be assigned to a field area
                          </Text>
                        )}
                      </View>
                      {isLocked ? (
                        <Ionicons name="lock-closed-outline" size={18} color="#94A3B8" />
                      ) : (
                        <View style={[styles.rowAction, assigned && styles.rowActionAssigned]}>
                          {assigned && <Ionicons name="checkmark" size={12} color="#15803D" />}
                          <Text style={[styles.rowActionText, assigned && styles.rowActionTextAssigned]}>
                            {assigned ? "Assigned" : "Assign"}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  );
                })
              )}
            </AestheticScrollView>

            <Pressable style={styles.doneButton} onPress={() => setManagingLocationId(null)}>
              <Text style={styles.doneText}>Done</Text>
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

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  headerSpacer: { width: 36 },
  headerTitle: { fontSize: 16, fontWeight: "800", color: "#062B59" },
  mapToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "#F1F5F9",
  },
  mapToggleActive: { backgroundColor: "#062B59" },
  mapToggleText: { fontSize: 12, fontWeight: "800", color: "#062B59" },
  mapToggleTextActive: { color: "#FFFFFF" },
  mapWrapper: {
    height: 150,
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  map: { flex: 1 },
  mapOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(248,250,252,0.85)" },
  mapOverlayText: { fontSize: 12, color: "#94A3B8", fontWeight: "600" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
  },
  searchInput: { flex: 1, fontSize: 14, fontWeight: "600", color: "#0F172A" },
  areaRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  areaRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E2E8F0" },
  areaRowPressed: { opacity: 0.6 },
  areaIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#E0F2FE", alignItems: "center", justifyContent: "center" },
  areaIconWrapInactive: { backgroundColor: "#F1F5F9" },
  areaBody: { flex: 1, minWidth: 0 },
  areaName: { fontSize: 14.5, fontWeight: "800", color: "#062B59" },
  areaNameInactive: { color: "#64748B" },
  areaMeta: { fontSize: 11.5, color: "#94A3B8", fontWeight: "600", marginTop: 2 },
  facesRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  faceStack: { flexDirection: "row" },
  // A white ring keeps overlapping faces legible against each other.
  face: { borderRadius: 14, borderWidth: 2, borderColor: "#FFFFFF" },
  faceOverlap: { marginLeft: -8 },
  facesText: { fontSize: 11.5, fontWeight: "700", color: "#475569" },
  facesEmpty: { fontSize: 11.5, fontWeight: "700", color: "#B45309" },
  assignDialog: { height: "88%" },
  dialogHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  dialogEyebrow: { fontSize: 11, fontWeight: "700", color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.4 },
  dialogTitle: { fontSize: 17, fontWeight: "900", color: "#062B59", marginTop: 2 },
  dialogCount: { alignItems: "center", backgroundColor: "#F0F7FF", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12 },
  dialogCountValue: { fontSize: 20, fontWeight: "900", color: "#062B59" },
  dialogCountLabel: { fontSize: 9.5, fontWeight: "700", color: "#64748B", textTransform: "uppercase", letterSpacing: 0.3 },
  dialogList: { flex: 1 },
  rowAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "#062B59",
  },
  rowActionAssigned: { backgroundColor: "#DCFCE7" },
  rowActionText: { fontSize: 11.5, fontWeight: "800", color: "#FFFFFF" },
  rowActionTextAssigned: { color: "#15803D" },
  modalSubtitle: { fontSize: 12, lineHeight: 17, color: "#B45309", fontWeight: "600", marginBottom: 12 },
  selectAllButton: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 2, marginBottom: 4 },
  selectAllDisabled: { opacity: 0.5 },
  selectAllText: { flex: 1, fontSize: 12.5, fontWeight: "700", color: "#062B59" },
  employeeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "transparent",
    marginBottom: 6,
  },
  employeeRowAssigned: { backgroundColor: "#F8FAFC", borderColor: "#E2E8F0" },
  employeeRowPressed: { backgroundColor: "#F1F5F9" },
  employeeRowDisabled: { opacity: 0.45 },
  employeeName: { fontSize: 14, color: "#0F172A", fontWeight: "700" },
  employeeMeta: { fontSize: 11, color: "#94A3B8", fontWeight: "600", marginTop: 1 },
  employeeNote: { fontSize: 10.5, color: "#B45309", fontWeight: "600", marginTop: 2 },
  unassignText: { fontSize: 12, fontWeight: "800", color: "#B91C1C" },
  doneButton: { marginTop: 14, height: 48, borderRadius: 14, backgroundColor: "#062B59", alignItems: "center", justifyContent: "center" },
  doneText: { color: "#FFFFFF", fontWeight: "800", fontSize: 14 },
});
