import "leaflet/dist/leaflet.css";

import { Component, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Edit3, MapPin, Plus, Trash2, Users } from "lucide-react";
import L from "leaflet";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import "./GeotaggingPage.css";
import { apiRequest } from "../../lib/api";

type EmployeeOption = {
  id: string;
  firstName: string;
  lastName: string;
  department: { name: string };
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

function isGlobalZoneLocation(location?: GeotaggedLocation | null) {
  return Boolean(location?.name && location.name.toLowerCase().includes("global zone"));
}

const initialForm = {
  name: "",
  latitude: "16.3222",
  longitude: "120.3656",
  radiusMeters: "120",
  employeeIds: [] as string[],
  assignAllEmployees: false,
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

function GeotaggingPageContent() {
  const [form, setForm] = useState(initialForm);
  const [locations, setLocations] = useState<GeotaggedLocation[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [assignmentError, setAssignmentError] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadIssues, setLoadIssues] = useState<string[]>([]);

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
  const assignAllEmployees = form.assignAllEmployees;

  const editingLocation = useMemo(
    () => locations.find((location) => location.id === editingLocationId) ?? null,
    [editingLocationId, locations],
  );
  const editingIsGlobalZone = isGlobalZoneLocation(editingLocation);

  const employeeRows = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    return employees
      .filter((employee) => {
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
  }, [currentLocationAssignedIds, employeeSearch, employees]);

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
      assignAllEmployees: Boolean(
        employees.length > 0 &&
          (location.employees?.length ?? 0) === employees.length &&
          employees.every((employee) =>
            location.employees?.some((entry) => entry.employee.id === employee.id),
          ),
      ),
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
      const payload = {
        name: form.name.trim(),
        latitude,
        longitude,
        radiusMeters: Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 100,
        employeeIds: form.employeeIds,
        assignAllEmployees: form.assignAllEmployees,
      };

      if (editingLocationId) {
        const updated = await apiRequest<GeotaggedLocation>(`/geolocation/locations/${editingLocationId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setLocations((current) => current.map((location) => (location.id === updated.id ? updated : location)));
      } else {
        const newLoc = await apiRequest<GeotaggedLocation>("/geolocation/locations", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setLocations((current) => [newLoc, ...current]);
        setSelectedLocationId(newLoc.id);
        setEditingLocationId(newLoc.id);
      }

      setForm((current) => ({
        ...initialForm,
        latitude: current.latitude,
        longitude: current.longitude,
      }));
    } catch (error) {
      console.error("Failed to save geotagged area", error);
      const message =
        error instanceof Error ? error.message : "Failed to save geotagged area";
      setAssignmentError(message);
      alert(message);
    }
  }

  async function removeLocation(id: string) {
    try {
      await apiRequest(`/geolocation/locations/${id}`, { method: "DELETE" });
      setLocations((current) => current.filter((location) => location.id !== id));
      if (selectedLocationId === id) {
        setSelectedLocationId("");
      }
      if (editingLocationId === id) {
        setEditingLocationId(null);
      }
    } catch (error) {
      console.error("Failed to delete location", error);
      alert(error instanceof Error ? error.message : "Failed to delete location");
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
        assignAllEmployees: false,
        employeeIds: current.employeeIds.filter((id) => id !== employeeId),
      }));
      return;
    }

    if (assignedEmployees.has(employeeId)) {
      return;
    }

    setForm((current) => ({
      ...current,
      assignAllEmployees: false,
      employeeIds: [...current.employeeIds, employeeId],
    }));
  }

  function removeEmployeeFromCurrentLocation(employeeId: string) {
    setForm((current) => ({
      ...current,
      assignAllEmployees: false,
      employeeIds: current.employeeIds.filter((id) => id !== employeeId),
    }));
  }

  function toggleAssignAllEmployees(checked: boolean) {
    setForm((current) => ({
      ...current,
      assignAllEmployees: checked,
      employeeIds: checked ? employees.map((employee) => employee.id) : [],
    }));
  }

  return (
    <div className="geotagging-page">
      <div className="geotagging-header">
        <div className="geotagging-header-text">
          <h2>Geotagged Locations</h2>
          <p>Define attendance zones on the street map and assign employees to each area.</p>
        </div>
      </div>

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
                const empName =
                  location.employees && location.employees.length > 0
                    ? location.employees.map(({ employee }) => `${employee.firstName} ${employee.lastName}`).join(", ")
                    : location.employee
                      ? `${location.employee.firstName} ${location.employee.lastName}`
                      : "Global Zone (All Employees)";

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
                      <small>
                        {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {location.radiusMeters}
                        m
                      </small>
                    </button>
                    <button
                      className="icon-button manage-employees-button"
                      type="button"
                      aria-label={`Manage employees for ${location.name}`}
                      onClick={() => focusLocation(location)}
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      aria-label={`Remove ${location.name}`}
                      onClick={() => removeLocation(location.id)}
                    >
                      <Trash2 size={14} />
                    </button>
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

          <p className="assignment-context">
            {editingLocationId ? (
              <>Managing assignments for <strong>{editingLocation?.name}</strong></>
            ) : (
              "Start a new area or select one below to manage its employees."
            )}
          </p>

          <div className={`employee-assignment-box${editingIsGlobalZone ? " locked" : ""}`}>
            <div className="employee-assignment-header">
              {!editingIsGlobalZone && (
                <label className="employee-assignment-label">
                  Search employees
                  <input
                    type="text"
                    value={employeeSearch}
                    onChange={(event) => setEmployeeSearch(event.target.value)}
                    placeholder="Search employees or departments"
                  />
                </label>
              )}
              <small className="field-help">
                {editingIsGlobalZone
                  ? "Global Zone is remove-only. You can unassign employees here, but you cannot add new ones."
                  : "Check employees to assign them here. Uncheck to remove them from this area."}
              </small>
            </div>

            {!editingIsGlobalZone && (
              <label className="assign-all-employees-toggle">
                <span className="assign-all-copy">
                  <strong>Assign All Employees</strong>
                  <small>Assign every current employee to this geotagged area.</small>
                </span>
                <input
                  type="checkbox"
                  checked={assignAllEmployees}
                  onChange={(event) => toggleAssignAllEmployees(event.target.checked)}
                />
              </label>
            )}

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

          <div className="selected-assignment">
            <div className="assignment-icon-wrap">
              <span>{assignedEmployees.size}</span>
            </div>
            <p>
              {assignedEmployees.size === 1 ? "employee" : "employees"} specifically assigned across {locations.length}{" "}
              {locations.length === 1 ? "area" : "areas"}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

export function GeotaggingPage() {
  return (
    <GeotaggingErrorBoundary>
      <GeotaggingPageContent />
    </GeotaggingErrorBoundary>
  );
}
