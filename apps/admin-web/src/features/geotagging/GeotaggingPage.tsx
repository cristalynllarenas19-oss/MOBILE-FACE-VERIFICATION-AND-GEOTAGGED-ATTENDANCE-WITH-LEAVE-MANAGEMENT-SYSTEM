import "leaflet/dist/leaflet.css";

import { Component, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Crosshair, Edit3, Eye, MapPin, Plus, Save, Search, Trash2, Users, X } from "lucide-react";
import L from "leaflet";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import "./GeotaggingPage.css";
import { apiRequest } from "../../lib/api";
import { PermissionCode, permissions } from "../../types/rbac";

type EmployeeOption = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo?: string;
  department: { name: string };
  position?: { title: string };
  user?: { email?: string };
};

type GeotaggedLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  employees?: Array<{ employee: EmployeeOption }>;
  employeeId?: string | null;
  employee?: EmployeeOption | null;
  isActive?: boolean;
};

type ConfirmConfig = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

function isGlobalZoneLocation(location?: GeotaggedLocation | null) {
  return Boolean(location?.name && location.name.toLowerCase().includes("global zone"));
}

const initialForm = {
  name: "",
  latitude: "16.3222",
  longitude: "120.3656",
  radiusMeters: "120",
  employeeIds: [] as string[],
};

const markerIcon = L.icon({
  iconRetinaUrl: markerIcon2xUrl,
  iconUrl: markerIconUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

class GeotaggingErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="geotagging-page">
          <div className="geotagging-banner error" role="alert">
            Geotagged Areas failed to render. Please refresh the page.
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function ConfirmModal({
  config,
  onCancel,
}: {
  config: ConfirmConfig;
  onCancel: () => void;
}) {
  return (
    <div className="geotagging-modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="geotagging-modal geotagging-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="confirm-modal-close"
          type="button"
          onClick={onCancel}
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="confirm-modal-body">
          <div className="confirm-modal-icon-wrap">
            <AlertTriangle size={26} strokeWidth={2} />
          </div>
          <h2 id="confirm-modal-title" className="confirm-modal-title">
            {config.title}
          </h2>
          <p className="confirm-modal-description">{config.description}</p>
        </div>

        <div className="confirm-modal-footer">
          <button type="button" className="outline-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => {
              config.onConfirm();
              onCancel();
            }}
          >
            {config.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function ViewAreaEmployeesModal({
  location,
  employeeList,
  onClose,
}: {
  location: GeotaggedLocation;
  employeeList: EmployeeOption[];
  onClose: () => void;
}) {
  return (
    <div className="geotagging-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="geotagging-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="geotagging-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="geotagging-modal-header">
          <div>
            <h2 id="geotagging-modal-title">{location.name}</h2>
            <p>
              {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {location.radiusMeters}m radius
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close area details">
            <X size={18} />
          </button>
        </div>

        <div className="geotagging-modal-body">
          {employeeList.length === 0 ? (
            <div className="employee-empty-state">
              <p>
                {isGlobalZoneLocation(location)
                  ? "All employees are covered by this Global Zone."
                  : "No employees assigned to this area yet."}
              </p>
            </div>
          ) : (
            <ul className="geotagging-modal-employee-list">
              {employeeList.map((employee) => (
                <li key={employee.id} className="geotagging-modal-employee-row">
                  <div className="geotagging-modal-employee-main">
                    <strong>
                      {employee.firstName} {employee.lastName}
                    </strong>
                    <span>{employee.department?.name ?? "No department"}</span>
                  </div>
                  <div className="geotagging-modal-employee-meta">
                    {employee.employeeNo && <span>{employee.employeeNo}</span>}
                    {employee.position?.title && <span>{employee.position.title}</span>}
                    {employee.user?.email && <span>{employee.user.email}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="geotagging-modal-footer">
          <button type="button" className="outline-button" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

function GeotaggingPageContent({ canWrite }: { canWrite: boolean }) {
  const [form, setForm] = useState(initialForm);
  const [locations, setLocations] = useState<GeotaggedLocation[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [assignmentError, setAssignmentError] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [viewingLocationId, setViewingLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadIssues, setLoadIssues] = useState<string[]>([]);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmConfig | null>(null);

  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const draftMarkerRef = useRef<L.Marker | null>(null);
  const draftCircleRef = useRef<L.Circle | null>(null);
  const savedLayerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    let alive = true;

    async function loadData() {
      setLoading(true);
      setLoadError("");
      setLoadIssues([]);
      setAssignmentError("");

      const empsPromise = apiRequest<EmployeeOption[]>("/employees");
      const locsPromise = apiRequest<GeotaggedLocation[]>("/geolocation/locations");

      try {
        const emps = await empsPromise;
        if (alive) {
          setEmployees(Array.isArray(emps) ? emps : []);
        }
      } catch (error) {
        console.error("Failed to load employees", error);
        if (alive) {
          setLoadError("Some geotagging data could not be loaded.");
          setLoadIssues((current) => [...current, "Employees could not be loaded."]);
        }
      }

      try {
        const locs = await locsPromise;
        if (alive) {
          setLocations(Array.isArray(locs) ? locs : []);
          setSelectedLocationId(locs?.[0]?.id ?? "");
          setEditingLocationId(null);
        }
      } catch (error) {
        console.error("Failed to load locations", error);
        if (alive) {
          setLoadError("Some geotagging data could not be loaded.");
          setLoadIssues((current) => [...current, "Geotagged locations could not be loaded."]);
        }
      }

      if (alive) {
        setLoading(false);
      }
    }

    loadData();

    return () => {
      alive = false;
    };
  }, []);

  const latitude = Number(form.latitude);
  const longitude = Number(form.longitude);
  const radiusMeters = Number(form.radiusMeters);
  const previewPosition = useMemo<[number, number]>(
    () => [
      Number.isFinite(latitude) ? latitude : 16.3222,
      Number.isFinite(longitude) ? longitude : 120.3656,
    ],
    [latitude, longitude],
  );

  const assignedEmployees = useMemo(
    () =>
      new Set(
        locations.flatMap(
          (location) =>
            location.employees?.map((entry) => entry.employee.id) ?? (location.employeeId ? [location.employeeId] : []),
        ),
      ),
    [locations],
  );

  const currentLocationAssignedIds = useMemo(() => new Set(form.employeeIds), [form.employeeIds]);

  const editingLocation = useMemo(
    () => locations.find((location) => location.id === editingLocationId) ?? null,
    [editingLocationId, locations],
  );
  const editingIsGlobalZone = isGlobalZoneLocation(editingLocation);

  const viewingLocation = useMemo(
    () => locations.find((location) => location.id === viewingLocationId) ?? null,
    [viewingLocationId, locations],
  );

  const employeesById = useMemo(() => {
    const map = new Map<string, EmployeeOption>();
    employees.forEach((employee) => map.set(employee.id, employee));
    return map;
  }, [employees]);

  function getLocationEmployees(location: GeotaggedLocation): EmployeeOption[] {
    const baseList =
      location.employees && location.employees.length > 0
        ? location.employees.map((entry) => entry.employee)
        : location.employee
          ? [location.employee]
          : [];
    return baseList.map((employee) => employeesById.get(employee.id) ?? employee);
  }

  const departmentOptions = useMemo(() => {
    const names = new Set<string>();
    employees.forEach((employee) => {
      if (employee.department?.name) {
        names.add(employee.department.name);
      }
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [employees]);

  const employeeRows = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    return employees
      .filter((employee) => {
        if (departmentFilter && employee.department?.name !== departmentFilter) {
          return false;
        }
        if (!query) return true;
        const fullName = `${employee.firstName} ${employee.lastName}`.toLowerCase();
        const department = employee.department?.name?.toLowerCase() ?? "";
        return fullName.includes(query) || department.includes(query);
      })
      .sort((a, b) => {
        const aAssigned = currentLocationAssignedIds.has(a.id);
        const bAssigned = currentLocationAssignedIds.has(b.id);
        if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
        return `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
      });
  }, [currentLocationAssignedIds, departmentFilter, employeeSearch, employees]);

  const normalizedLocations = useMemo(
    () =>
      locations.map((location) => ({
        ...location,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        radiusMeters: Number(location.radiusMeters),
      })),
    [locations],
  );

  function focusLocation(location: GeotaggedLocation) {
    const nextLatitude = Number(location.latitude);
    const nextLongitude = Number(location.longitude);

    setSelectedLocationId(location.id);
    setEditingLocationId(location.id);
    setAssignmentError("");
    setForm((current) => ({
      ...current,
      name: location.name,
      latitude: Number.isFinite(nextLatitude) ? nextLatitude.toFixed(6) : current.latitude,
      longitude: Number.isFinite(nextLongitude) ? nextLongitude.toFixed(6) : current.longitude,
      radiusMeters: Number(location.radiusMeters).toString(),
      employeeIds:
        location.employees?.map((entry) => entry.employee.id) ??
        (location.employeeId ? [location.employeeId] : location.employee ? [location.employee.id] : []),
    }));

    const map = mapRef.current;
    if (map && Number.isFinite(nextLatitude) && Number.isFinite(nextLongitude)) {
      map.setView([nextLatitude, nextLongitude], map.getZoom(), {
        animate: true,
      });
    }
  }

  const updateDraftOverlay = (map: L.Map, nextCenter: [number, number], nextRadius: number) => {
    const currentMarker = draftMarkerRef.current;
    const currentCircle = draftCircleRef.current;

    if (currentMarker) {
      currentMarker.setLatLng(nextCenter);
    }

    if (currentCircle) {
      currentCircle.setLatLng(nextCenter);
      currentCircle.setRadius(nextRadius);
    } else if (Number.isFinite(nextRadius) && nextRadius > 0) {
      draftCircleRef.current = L.circle(nextCenter, {
        radius: nextRadius,
        color: "#2563eb",
        fillColor: "#38bdf8",
        fillOpacity: 0.18,
      }).addTo(map);
    }
  };

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapElementRef.current, {
      center: previewPosition,
      zoom: 15,
      scrollWheelZoom: true,
    });

    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    draftMarkerRef.current = L.marker(previewPosition, { icon: markerIcon }).addTo(map);
    draftMarkerRef.current.bindPopup("Draft location");

    map.on("click", (event) => {
      setForm((current) => ({
        ...current,
        latitude: event.latlng.lat.toFixed(6),
        longitude: event.latlng.lng.toFixed(6),
      }));
    });

    return () => {
      map.off();
      map.remove();
      mapRef.current = null;
      draftMarkerRef.current = null;
      draftCircleRef.current = null;
      savedLayerRef.current = null;
    };
  }, [previewPosition]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    map.setView(previewPosition, map.getZoom(), { animate: true });

    if (!draftMarkerRef.current) {
      draftMarkerRef.current = L.marker(previewPosition, { icon: markerIcon }).addTo(map);
      draftMarkerRef.current.bindPopup("Draft location");
    } else {
      draftMarkerRef.current.setLatLng(previewPosition);
    }

    updateDraftOverlay(map, previewPosition, Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 0);
  }, [previewPosition, radiusMeters]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (savedLayerRef.current) {
      savedLayerRef.current.remove();
    }

    const layerGroup = L.layerGroup().addTo(map);

    normalizedLocations.forEach((location) => {
      const isSelected = selectedLocationId === location.id;
      const empName =
        location.employees && location.employees.length > 0
          ? location.employees.map(({ employee }) => `${employee.firstName} ${employee.lastName}`).join(", ")
          : location.employee
            ? `${location.employee.firstName} ${location.employee.lastName}`
          : "Global Zone (All Employees)";

      L.circle([location.latitude, location.longitude], {
        radius: location.radiusMeters,
        color: isSelected ? "#15803d" : "#64748b",
        fillColor: isSelected ? "#22c55e" : "#94a3b8",
        fillOpacity: 0.22,
      }).addTo(layerGroup);

      const marker = L.marker([location.latitude, location.longitude], { icon: markerIcon }).addTo(layerGroup);
      marker.bindPopup(
        `<div class="map-popup"><strong>${location.name}</strong><span>${empName}</span><span class="popup-radius">${location.radiusMeters}m radius</span></div>`,
      );
      marker.on("click", () => {
        setSelectedLocationId(location.id);
        setForm((current) => ({
          ...current,
          latitude: location.latitude.toFixed(6),
          longitude: location.longitude.toFixed(6),
        }));
      });
    });

    savedLayerRef.current = layerGroup;
  }, [normalizedLocations, selectedLocationId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!form.name.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    try {
      setAssignmentError("");
      const areaPayload = {
        name: form.name.trim(),
        latitude,
        longitude,
        radiusMeters: Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 100,
      };

      if (editingLocationId) {
        const updated = await apiRequest<GeotaggedLocation>(`/geolocation/locations/${editingLocationId}`, {
          method: "PATCH",
          body: JSON.stringify(areaPayload),
        });
        setLocations((current) => current.map((location) => (location.id === updated.id ? updated : location)));
      } else {
        const newLoc = await apiRequest<GeotaggedLocation>("/geolocation/locations", {
          method: "POST",
          body: JSON.stringify({ ...areaPayload, employeeIds: form.employeeIds }),
        });
        setLocations((current) => [newLoc, ...current]);
        setSelectedLocationId(newLoc.id);
        setEditingLocationId(newLoc.id);
        setForm((current) => ({
          ...current,
          name: newLoc.name,
          employeeIds: newLoc.employees?.map((entry) => entry.employee.id) ?? current.employeeIds,
        }));
      }
    } catch (error) {
      console.error("Failed to save geotagged area", error);
      const message =
        error instanceof Error ? error.message : "Failed to save geotagged area";
      setAssignmentError(message);
    }
  }

  async function handleSaveAssignments() {
    if (!editingLocationId) {
      return;
    }

    try {
      setSavingAssignments(true);
      setAssignmentError("");
      const updated = await apiRequest<GeotaggedLocation>(`/geolocation/locations/${editingLocationId}`, {
        method: "PATCH",
        body: JSON.stringify({ employeeIds: form.employeeIds }),
      });
      setLocations((current) => current.map((location) => (location.id === updated.id ? updated : location)));
      setForm((current) => ({
        ...current,
        employeeIds: updated.employees?.map((entry) => entry.employee.id) ?? current.employeeIds,
      }));
    } catch (error) {
      console.error("Failed to save employee assignments", error);
      const message = error instanceof Error ? error.message : "Failed to save employee assignments";
      setAssignmentError(message);
    } finally {
      setSavingAssignments(false);
    }
  }

  function confirmRemoveLocation(location: GeotaggedLocation) {
    const employeeCount = getLocationEmployees(location).length;
    setConfirmConfig({
      title: "Remove Geotagged Area",
      description:
        employeeCount > 0
          ? `Are you sure you want to remove "${location.name}"? This will unassign ${employeeCount} employee${employeeCount === 1 ? "" : "s"} from this area. This action cannot be undone.`
          : `Are you sure you want to remove "${location.name}"? This action cannot be undone.`,
      confirmLabel: "Remove Area",
      onConfirm: () => removeLocation(location),
    });
  }

  async function removeLocation(location: GeotaggedLocation) {
    const id = location.id;

    try {
      await apiRequest(`/geolocation/locations/${id}`, { method: "DELETE" });
      setLocations((current) => current.filter((loc) => loc.id !== id));
      if (selectedLocationId === id) {
        setSelectedLocationId("");
      }
      if (editingLocationId === id) {
        setEditingLocationId(null);
      }
      if (viewingLocationId === id) {
        setViewingLocationId(null);
      }
    } catch (error) {
      console.error("Failed to delete location", error);
      const message = error instanceof Error ? error.message : "Failed to delete location";
      setAssignmentError(message);
    }
  }

  function startCreateMode() {
    setEditingLocationId(null);
    setSelectedLocationId("");
    setForm((current) => ({
      ...initialForm,
      latitude: current.latitude,
      longitude: current.longitude,
    }));
    setAssignmentError("");
  }

  function toggleEmployee(employeeId: string) {
    if (editingIsGlobalZone) {
      return;
    }

    const isSelected = currentLocationAssignedIds.has(employeeId);

    if (isSelected) {
      setForm((current) => ({
        ...current,
        employeeIds: current.employeeIds.filter((id) => id !== employeeId),
      }));
      return;
    }

    if (assignedEmployees.has(employeeId)) {
      return;
    }

    setForm((current) => ({
      ...current,
      employeeIds: [...current.employeeIds, employeeId],
    }));
  }

  function removeEmployeeFromCurrentLocation(employeeId: string) {
    setForm((current) => ({
      ...current,
      employeeIds: current.employeeIds.filter((id) => id !== employeeId),
    }));
  }

  return (
    <div className="geotagging-page">

      {loadError && (
        <div className="geotagging-banner error" role="alert">
          <div>{loadError} The page will still work with the data that did arrive.</div>
          {loadIssues.length > 0 && (
            <ul className="geotagging-load-issues">
              {loadIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="geotagging-top-grid">
        <section className="geotagging-map-panel" aria-label="OpenStreetMap geotagging map">
          <div className="map-panel-header">
            <MapPin size={15} className="map-panel-icon" />
            <span>Street Map - Click anywhere to pin a location</span>
          </div>
          <div ref={mapElementRef} className="geotagging-map" />
          {loading && <div className="map-loading-overlay">Loading map...</div>}
        </section>

        <div className="geotagging-top-right">
          <div className="geotagging-stats">
            <div className="geotagging-stat-card">
              <span className="stat-value">{locations.length}</span>
              <span className="stat-label">Active Zones</span>
            </div>
            <div className="geotagging-stat-card">
              <span className="stat-value">{assignedEmployees.size}</span>
              <span className="stat-label">Assigned Employees</span>
            </div>
          </div>

          {canWrite && (
            <form onSubmit={handleSubmit} className="geotagging-form">
              <div className="panel-heading">
                <div className="panel-heading-icon">
                  <Plus size={14} />
                </div>
                <h3>{editingLocationId ? "Edit Location" : "Add Location"}</h3>
              </div>

              {editingIsGlobalZone && (
                <div className="geotagging-banner info" role="note">
                  Global Zone is assignment-locked. Remove employees from their current area before assigning them to a new
                  location.
                </div>
              )}

              {assignmentError && (
                <div className="geotagging-banner error" role="alert">
                  {assignmentError}
                </div>
              )}

              <label>
                Location name
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="e.g., Leaf buying station"
                  required
                />
              </label>

              <div className="coordinate-grid">
                <label>
                  Latitude
                  <input
                    type="number"
                    step="0.000001"
                    value={form.latitude}
                    onChange={(event) => setForm((current) => ({ ...current, latitude: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  Longitude
                  <input
                    type="number"
                    step="0.000001"
                    value={form.longitude}
                    onChange={(event) => setForm((current) => ({ ...current, longitude: event.target.value }))}
                    required
                  />
                </label>
              </div>

              <label>
                Area radius (meters)
                <div className="radius-input-wrap">
                  <input
                    type="number"
                    min="25"
                    max="1000"
                    step="5"
                    value={form.radiusMeters}
                    onChange={(event) => setForm((current) => ({ ...current, radiusMeters: event.target.value }))}
                    required
                  />
                  <span className="radius-unit">m</span>
                </div>
              </label>

              <div className="geotagging-actions">
                <button className="outline-button" type="button" onClick={startCreateMode}>
                  <Crosshair size={14} />
                  <span>New Area</span>
                </button>
                <button className="primary-button" type="submit" disabled={loading}>
                  <Plus size={14} />
                  <span>{editingLocationId ? "Save Changes" : "Add Area"}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <div className="geotagging-bottom-grid">
        <section className="assigned-list" aria-label="Assigned geotagged areas">
          <div className="panel-heading">
            <div className="panel-heading-icon neutral">
              <MapPin size={14} />
            </div>
            <h3>Assigned Areas</h3>
            <span className="area-count-badge">{locations.length}</span>
          </div>

          <div className="assigned-list-scroll">
            {locations.length === 0 ? (
              <div className="empty-state">
                <MapPin size={28} strokeWidth={1.2} />
                {loading ? (
                  <>
                    <p>Loading geotagged areas...</p>
                    <small>Please wait while we fetch the current work locations.</small>
                  </>
                ) : (
                  <>
                    <p>No geotagged areas added yet.</p>
                    <small>Click the map to drop a pin.</small>
                  </>
                )}
              </div>
            ) : (
              locations.map((location) => {
                const locationEmployees = getLocationEmployees(location);
                const empName =
                  locationEmployees.length > 0
                    ? locationEmployees.map((employee) => `${employee.firstName} ${employee.lastName}`).join(", ")
                    : "Global Zone (All Employees)";
                const deptNames = Array.from(
                  new Set(locationEmployees.map((employee) => employee.department?.name).filter(Boolean)),
                ) as string[];

                return (
                  <article
                    className={`assigned-location ${selectedLocationId === location.id ? "selected" : ""}`}
                    key={location.id}
                  >
                    <button
                      className="assigned-location-main"
                      type="button"
                      onClick={() => focusLocation(location)}
                    >
                      <strong>{location.name}</strong>
                      <span>{empName}</span>
                      {deptNames.length > 0 && (
                        <span className="assigned-location-dept">{deptNames.join(", ")}</span>
                      )}
                      <small>
                        {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {location.radiusMeters}
                        m
                      </small>
                    </button>
                    <div className="assigned-location-actions">
                      {/* View button */}
                      <button
                        className="icon-button location-action-btn location-action-btn--view"
                        type="button"
                        aria-label={`View details for ${location.name}`}
                        onClick={() => setViewingLocationId(location.id)}
                      >
                        <Eye size={14} />
                      </button>
                      {/* Edit button */}
                      <button
                        className="icon-button location-action-btn location-action-btn--edit"
                        type="button"
                        aria-label={canWrite ? `Manage employees for ${location.name}` : `View employees for ${location.name}`}
                        onClick={() => focusLocation(location)}
                      >
                        <Edit3 size={14} />
                      </button>
                      {/* Delete button */}
                      {canWrite && (
                        <button
                          className="icon-button location-action-btn location-action-btn--delete"
                          type="button"
                          aria-label={`Remove ${location.name}`}
                          onClick={() => confirmRemoveLocation(location)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className="assigned-employees-panel" aria-label="Assigned employees">
          <div className="panel-heading">
            <div className="panel-heading-icon neutral">
              <Users size={14} />
            </div>
            <h3>Assigned Employees</h3>
            <span className="area-count-badge">{assignedEmployees.size}</span>
          </div>

          {editingLocationId && (
            <p className="assignment-context">
              Managing assignments for <strong>{editingLocation?.name}</strong>
            </p>
          )}

          <div className={`employee-assignment-box${editingIsGlobalZone ? " locked" : ""}`}>
            <div className="employee-assignment-header">
              {!editingIsGlobalZone && (
                <div className="employee-filter-row">
                  <label className="employee-assignment-label employee-search-label">
                    Search employees
                    <div className="employee-search-input-wrap">
                      <Search size={14} className="employee-search-icon" />
                      <input
                        type="text"
                        value={employeeSearch}
                        onChange={(event) => setEmployeeSearch(event.target.value)}
                        placeholder="Search employees or departments"
                      />
                    </div>
                  </label>
                  <label className="employee-assignment-label employee-department-label">
                    Department
                    <select
                      value={departmentFilter}
                      onChange={(event) => setDepartmentFilter(event.target.value)}
                    >
                      <option value="">All departments</option>
                      {departmentOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <small className="field-help">
                {!canWrite
                  ? "Employees assigned to this area."
                  : editingIsGlobalZone
                    ? "Global Zone is remove-only. You can unassign employees here, but you cannot add new ones."
                    : "Check employees to assign them here. Uncheck to remove them from this area."}
              </small>
            </div>

            <div className="employee-checklist" role="group" aria-label="Employee assignment checklist">
              {employeeRows.length === 0 ? (
                <div className="employee-empty-state">
                  <p>No employees match your search.</p>
                  <small>Try a different name or department.</small>
                </div>
              ) : (
                employeeRows.map((employee) => {
                  const isSelected = currentLocationAssignedIds.has(employee.id);
                  const isAssignedElsewhere = assignedEmployees.has(employee.id) && !isSelected;

                  if (!canWrite) {
                    if (!isSelected) return null;
                    return (
                      <div key={employee.id} className="employee-checklist-item selected">
                        <span className="employee-checklist-main">
                          <span className="employee-checklist-name">
                            {employee.firstName} {employee.lastName}
                          </span>
                          <span className="employee-checklist-meta">{employee.department?.name}</span>
                        </span>
                      </div>
                    );
                  }

                  return (
                    editingIsGlobalZone ? (
                      isSelected ? (
                        <div key={employee.id} className="employee-checklist-item selected">
                          <span className="employee-checklist-main">
                            <span className="employee-checklist-name">
                              {employee.firstName} {employee.lastName}
                            </span>
                            <span className="employee-checklist-meta">{employee.department?.name}</span>
                          </span>
                            <button
                              type="button"
                              className="employee-unassign-button"
                              onClick={() => removeEmployeeFromCurrentLocation(employee.id)}
                            >
                              Unassign
                            </button>
                        </div>
                      ) : null
                    ) : (
                      <label
                        key={employee.id}
                        className={`employee-checklist-item${isSelected ? " selected" : ""}${isAssignedElsewhere ? " disabled" : ""}`}
                      >
                        <span className="employee-checklist-main">
                          <span className="employee-checklist-name">
                            {employee.firstName} {employee.lastName}
                          </span>
                          <span className="employee-checklist-meta">{employee.department?.name}</span>
                          {isAssignedElsewhere && (
                            <span className="employee-assigned-note">
                              Already assigned to another geotagged area
                            </span>
                          )}
                        </span>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isAssignedElsewhere || (loading && employees.length === 0)}
                          onChange={() => toggleEmployee(employee.id)}
                        />
                      </label>
                    )
                  );
                })
              )}
            </div>
          </div>

          {canWrite && (
            <div className="assignment-save-row">
              {editingLocationId && (
                <button
                  className="outline-button"
                  type="button"
                  onClick={startCreateMode}
                >
                  <span>Cancel</span>
                </button>
              )}
              <button
                className="primary-button"
                type="button"
                disabled={!editingLocationId || savingAssignments}
                onClick={handleSaveAssignments}
              >
                <Save size={14} />
                <span>{savingAssignments ? "Saving..." : "Save Assignments"}</span>
              </button>
            </div>
          )}
        </section>
      </div>

      {viewingLocation && (
        <ViewAreaEmployeesModal
          location={viewingLocation}
          employeeList={getLocationEmployees(viewingLocation)}
          onClose={() => setViewingLocationId(null)}
        />
      )}

      {confirmConfig && (
        <ConfirmModal
          config={confirmConfig}
          onCancel={() => setConfirmConfig(null)}
        />
      )}
    </div>
  );
}

export function GeotaggingPage({ user }: { user?: { permissions: PermissionCode[] } }) {
  const canWrite = user?.permissions.includes(permissions.geolocationWrite) ?? true;
  return (
    <GeotaggingErrorBoundary>
      <GeotaggingPageContent canWrite={canWrite} />
    </GeotaggingErrorBoundary>
  );
}