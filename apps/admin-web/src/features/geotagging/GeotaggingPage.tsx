import "leaflet/dist/leaflet.css";

import { Circle, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { Crosshair, MapPin, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
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

function CoordinatePicker({
  onPick,
}: {
  onPick: (latitude: number, longitude: number) => void;
}) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });

  return null;
}

function MapViewController({ center }: { center: [number, number] }) {
  const map = useMap();

  useEffect(() => {
    map.setView(center, map.getZoom(), { animate: true });
  }, [center, map]);

  return null;
}

export function GeotaggingPage() {
  const [form, setForm] = useState(initialForm);
  const [locations, setLocations] = useState<GeotaggedLocation[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");

  useEffect(() => {
    async function loadData() {
      try {
        const [emps, locs] = await Promise.all([
          apiRequest<EmployeeOption[]>("/employees"),
          apiRequest<GeotaggedLocation[]>("/geolocation/locations"),
        ]);
        setEmployees(emps);
        setLocations(locs);
        
        if (locs.length > 0) {
          setSelectedLocationId(locs[0].id);
        }
      } catch (error) {
        console.error("Failed to load data", error);
      }
    }
    loadData();
  }, []);

  const latitude = Number(form.latitude);
  const longitude = Number(form.longitude);
  const radiusMeters = Number(form.radiusMeters);
  const selectedEmployee = employees.find((employee) => employee.id === form.employeeId);
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

  function handleMapPick(nextLatitude: number, nextLongitude: number) {
    setForm((current) => ({
      ...current,
      latitude: nextLatitude.toFixed(6),
      longitude: nextLongitude.toFixed(6),
    }));
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
      {/* ── Header ── */}
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

      {/* ── Workspace ── */}
      <div className="geotagging-workspace">
        {/* Map */}
        <section className="geotagging-map-panel" aria-label="OpenStreetMap geotagging map">
          <div className="map-panel-header">
            <MapPin size={15} className="map-panel-icon" />
            <span>Street Map — Click anywhere to pin a location</span>
          </div>
          <MapContainer center={previewPosition} zoom={15} scrollWheelZoom className="geotagging-map">
            {/* OpenStreetMap street tile */}
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={19}
            />
            <CoordinatePicker onPick={handleMapPick} />
            <MapViewController center={previewPosition} />

            {/* Draft marker */}
            <Marker icon={markerIcon} position={previewPosition}>
              <Popup>
                <div className="map-popup">
                  <strong>📍 Draft location</strong>
                  <span>{previewPosition[0].toFixed(6)}, {previewPosition[1].toFixed(6)}</span>
                </div>
              </Popup>
            </Marker>

            {/* Draft radius */}
            {Number.isFinite(radiusMeters) && radiusMeters > 0 && (
              <Circle
                center={previewPosition}
                pathOptions={{ color: "#2563eb", fillColor: "#38bdf8", fillOpacity: 0.18 }}
                radius={radiusMeters}
              />
            )}

            {/* Saved circles */}
            {locations.map((location) => (
              <Circle
                key={location.id}
                center={[location.latitude, location.longitude]}
                pathOptions={{
                  color: selectedLocationId === location.id ? "#15803d" : "#64748b",
                  fillColor: selectedLocationId === location.id ? "#22c55e" : "#94a3b8",
                  fillOpacity: 0.22,
                }}
                radius={location.radiusMeters}
              />
            ))}

            {/* Saved markers */}
            {locations.map((location) => {
              const empName = location.employee ? `${location.employee.firstName} ${location.employee.lastName}` : "Global Zone (All Employees)";
              return (
                <Marker
                  eventHandlers={{ click: () => setSelectedLocationId(location.id) }}
                  icon={markerIcon}
                  key={`${location.id}-marker`}
                  position={[location.latitude, location.longitude]}
                >
                  <Popup>
                    <div className="map-popup">
                      <strong>{location.name}</strong>
                      <span>{empName}</span>
                      <span className="popup-radius">{location.radiusMeters}m radius</span>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        </section>

        {/* Sidebar */}
        <aside className="geotagging-form-panel">
          {/* Add location form */}
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
              >
                <option value="">Global (All Employees)</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.firstName} {employee.lastName} — {employee.department?.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="geotagging-actions">
              <button
                className="outline-button"
                type="button"
                onClick={() => handleMapPick(16.3222, 120.3656)}
              >
                <Crosshair size={14} />
                <span>Agoo Center</span>
              </button>
              <button className="primary-button" type="submit">
                <Plus size={14} />
                <span>Add Area</span>
              </button>
            </div>
          </form>

          {/* Assigned list */}
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
                <p>No geotagged areas added yet.</p>
                <small>Click the map to drop a pin.</small>
              </div>
            ) : (
              locations.map((location) => {
                const empName = location.employee ? `${location.employee.firstName} ${location.employee.lastName}` : "Global Zone (All Employees)";
                return (
                  <article
                    className={`assigned-location ${selectedLocationId === location.id ? "selected" : ""}`}
                    key={location.id}
                  >
                    <button
                      className="assigned-location-main"
                      type="button"
                      onClick={() => {
                        setSelectedLocationId(location.id);
                        handleMapPick(location.latitude, location.longitude);
                      }}
                    >
                      <strong>{location.name}</strong>
                      <span>{empName}</span>
                      <small>
                        {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {location.radiusMeters}m
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

          {/* Footer summary */}
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
