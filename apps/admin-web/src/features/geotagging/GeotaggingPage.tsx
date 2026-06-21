import "leaflet/dist/leaflet.css";

import { Component, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, MapPin, Plus, Trash2 } from "lucide-react";
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
  employeeId: string | null;
  employee?: EmployeeOption | null;
};

const initialForm = {
  name: "",
  latitude: "16.3222",
  longitude: "120.3656",
  radiusMeters: "120",
  employeeId: "",
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

const partialLoadMessage =
  "Some geotagging data could not be loaded. The page will still work with the data that did arrive.";

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
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

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
          setLoadError(partialLoadMessage);
        }
      }

      try {
        const locs = await locsPromise;
        if (alive) {
          setLocations(Array.isArray(locs) ? locs : []);
          setSelectedLocationId(locs?.[0]?.id ?? "");
        }
      } catch (error) {
        console.error("Failed to load locations", error);
        if (alive) {
          setLoadError(partialLoadMessage);
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
    () => new Set(locations.map((location) => location.employeeId).filter(Boolean)),
    [locations],
  );

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
    setForm((current) => ({
      ...current,
      latitude: Number.isFinite(nextLatitude) ? nextLatitude.toFixed(6) : current.latitude,
      longitude: Number.isFinite(nextLongitude) ? nextLongitude.toFixed(6) : current.longitude,
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
      const empName = location.employee
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
      const newLoc = await apiRequest<GeotaggedLocation>("/geolocation/locations", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          latitude,
          longitude,
          radiusMeters: Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 100,
          employeeId: form.employeeId || null,
        }),
      });

      setLocations((current) => [newLoc, ...current]);
      setSelectedLocationId(newLoc.id);
      setForm((current) => ({ ...initialForm, latitude: current.latitude, longitude: current.longitude }));
    } catch (error) {
      console.error("Failed to save location", error);
      alert("Failed to save location");
    }
  }

  async function removeLocation(id: string) {
    try {
      await apiRequest(`/geolocation/locations/${id}`, { method: "DELETE" });
      setLocations((current) => current.filter((location) => location.id !== id));
      if (selectedLocationId === id) {
        setSelectedLocationId("");
      }
    } catch (error) {
      console.error("Failed to delete location", error);
      alert("Failed to delete location");
    }
  }

  return (
    <div className="geotagging-page">
      <div className="geotagging-header">
        <div className="geotagging-header-text">
          <h2>Geotagged Locations</h2>
          <p>Define attendance zones on the street map and assign employees to each area.</p>
        </div>
        <div className="geotagging-stats">
          <div className="geotagging-stat-card">
            <span className="stat-value">{locations.length}</span>
            <span className="stat-label">Active Zones</span>
          </div>
          <div className="geotagging-stat-card">
            <span className="stat-value">{assignedEmployees.size}</span>
            <span className="stat-label">Assigned</span>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="geotagging-banner error" role="alert">
          {loadError}
        </div>
      )}

      <div className="geotagging-workspace">
        <section className="geotagging-map-panel" aria-label="OpenStreetMap geotagging map">
          <div className="map-panel-header">
            <MapPin size={15} className="map-panel-icon" />
            <span>Street Map - Click anywhere to pin a location</span>
          </div>
          <div ref={mapElementRef} className="geotagging-map" />
          {loading && <div className="map-loading-overlay">Loading map...</div>}
        </section>

        <aside className="geotagging-form-panel">
          <form onSubmit={handleSubmit} className="geotagging-form">
            <div className="panel-heading">
              <div className="panel-heading-icon">
                <Plus size={14} />
              </div>
              <h3>Add Location</h3>
            </div>

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

            <label>
              Assigned employee (Optional)
              <select
                value={form.employeeId}
                onChange={(event) => setForm((current) => ({ ...current, employeeId: event.target.value }))}
                disabled={loading && employees.length === 0}
              >
                <option value="">Global (All Employees)</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.firstName} {employee.lastName} - {employee.department?.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="geotagging-actions">
              <button className="outline-button" type="button" onClick={() => setForm((current) => ({ ...current, latitude: "16.3222", longitude: "120.3656" }))}>
                <Crosshair size={14} />
                <span>Agoo Center</span>
              </button>
              <button className="primary-button" type="submit" disabled={loading}>
                <Plus size={14} />
                <span>Add Area</span>
              </button>
            </div>
          </form>

          <section className="assigned-list" aria-label="Assigned geotagged areas">
            <div className="panel-heading">
              <div className="panel-heading-icon neutral">
                <MapPin size={14} />
              </div>
              <h3>Assigned Areas</h3>
              <span className="area-count-badge">{locations.length}</span>
            </div>

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
                const empName = location.employee
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
          </section>

          <div className="selected-assignment">
            <div className="assignment-icon-wrap">
              <span>{assignedEmployees.size}</span>
            </div>
            <p>
              {assignedEmployees.size === 1 ? "employee" : "employees"} specifically assigned across {locations.length}{" "}
              {locations.length === 1 ? "area" : "areas"}
            </p>
          </div>
        </aside>
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
