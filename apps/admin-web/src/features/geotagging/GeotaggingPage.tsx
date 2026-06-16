import "leaflet/dist/leaflet.css";

import { Circle, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { Crosshair, MapPin, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import L from "leaflet";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import "./GeotaggingPage.css";

type EmployeeOption = {
  id: string;
  name: string;
  department: string;
};

type GeotaggedLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  employeeId: string;
  employeeName: string;
};

const defaultEmployees: EmployeeOption[] = [
  { id: "EMP-001", name: "Maria Santos", department: "Operations" },
  { id: "EMP-002", name: "Juan Dela Cruz", department: "Field Team" },
  { id: "EMP-003", name: "Ana Reyes", department: "Quality Control" },
  { id: "EMP-004", name: "Paolo Garcia", department: "Warehouse" },
];

const initialForm = {
  name: "",
  latitude: "16.3222",
  longitude: "120.3656",
  radiusMeters: "120",
  employeeId: defaultEmployees[0].id,
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
  const [locations, setLocations] = useState<GeotaggedLocation[]>([
    {
      id: "geo-1",
      name: "Agoo Main Work Area",
      latitude: 16.3222,
      longitude: 120.3656,
      radiusMeters: 150,
      employeeId: "EMP-001",
      employeeName: "Maria Santos",
    },
  ]);
  const [selectedLocationId, setSelectedLocationId] = useState("geo-1");

  const latitude = Number(form.latitude);
  const longitude = Number(form.longitude);
  const radiusMeters = Number(form.radiusMeters);
  const selectedEmployee = defaultEmployees.find((employee) => employee.id === form.employeeId);
  const previewPosition = useMemo<[number, number]>(
    () => [
      Number.isFinite(latitude) ? latitude : 16.3222,
      Number.isFinite(longitude) ? longitude : 120.3656,
    ],
    [latitude, longitude],
  );

  const assignedEmployees = useMemo(
    () => new Set(locations.map((location) => location.employeeId)),
    [locations],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!form.name.trim() || !selectedEmployee || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    const newLocation: GeotaggedLocation = {
      id: `geo-${Date.now()}`,
      name: form.name.trim(),
      latitude,
      longitude,
      radiusMeters: Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 100,
      employeeId: selectedEmployee.id,
      employeeName: selectedEmployee.name,
    };

    setLocations((current) => [newLocation, ...current]);
    setSelectedLocationId(newLocation.id);
    setForm((current) => ({ ...initialForm, latitude: current.latitude, longitude: current.longitude }));
  }

  function handleMapPick(nextLatitude: number, nextLongitude: number) {
    setForm((current) => ({
      ...current,
      latitude: nextLatitude.toFixed(6),
      longitude: nextLongitude.toFixed(6),
    }));
  }

  function removeLocation(id: string) {
    setLocations((current) => current.filter((location) => location.id !== id));
    if (selectedLocationId === id) {
      setSelectedLocationId("");
    }
  }

  return (
    <div className="geotagging-page">
      <div className="geotagging-header">
        <div>
          <h2>Geotagged Locations</h2>
          <p>Add OpenStreetMap attendance areas and assign employees locally.</p>
        </div>
        <div className="geotagging-summary" aria-label="Geotagging summary">
          <span>{locations.length}</span>
          <small>Local areas</small>
        </div>
      </div>

      <div className="geotagging-workspace">
        <section className="geotagging-map-panel" aria-label="OpenStreetMap geotagging map">
          <MapContainer center={previewPosition} zoom={15} scrollWheelZoom className="geotagging-map">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <CoordinatePicker onPick={handleMapPick} />
            <MapViewController center={previewPosition} />
            <Marker icon={markerIcon} position={previewPosition}>
              <Popup>
                Draft location
                <br />
                {previewPosition[0].toFixed(6)}, {previewPosition[1].toFixed(6)}
              </Popup>
            </Marker>
            {Number.isFinite(radiusMeters) && radiusMeters > 0 && (
              <Circle
                center={previewPosition}
                pathOptions={{ color: "#2563eb", fillColor: "#38bdf8", fillOpacity: 0.18 }}
                radius={radiusMeters}
              />
            )}
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
            {locations.map((location) => (
              <Marker
                eventHandlers={{ click: () => setSelectedLocationId(location.id) }}
                icon={markerIcon}
                key={`${location.id}-marker`}
                position={[location.latitude, location.longitude]}
              >
                <Popup>
                  <strong>{location.name}</strong>
                  <br />
                  {location.employeeName}
                  <br />
                  {location.radiusMeters}m radius
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </section>

        <aside className="geotagging-form-panel">
          <form onSubmit={handleSubmit} className="geotagging-form">
            <div className="panel-heading">
              <MapPin size={18} />
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
              Area radius
              <input
                type="number"
                min="25"
                max="1000"
                step="5"
                value={form.radiusMeters}
                onChange={(event) => setForm((current) => ({ ...current, radiusMeters: event.target.value }))}
                required
              />
            </label>

            <label>
              Assigned employee
              <select
                value={form.employeeId}
                onChange={(event) => setForm((current) => ({ ...current, employeeId: event.target.value }))}
              >
                {defaultEmployees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} - {employee.department}
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
                <Crosshair size={16} />
                <span>Agoo Center</span>
              </button>
              <button className="primary-button" type="submit">
                <Plus size={16} />
                <span>Add Area</span>
              </button>
            </div>
          </form>

          <section className="assigned-list" aria-label="Assigned geotagged areas">
            <div className="panel-heading">
              <h3>Assigned Areas</h3>
            </div>
            {locations.length === 0 ? (
              <p className="empty-state">No local geotagged areas added yet.</p>
            ) : (
              locations.map((location) => (
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
                    <span>{location.employeeName}</span>
                    <small>
                      {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)} - {location.radiusMeters}m
                    </small>
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Remove ${location.name}`}
                    onClick={() => removeLocation(location.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              ))
            )}
          </section>

          <div className="selected-assignment">
            <span>{assignedEmployees.size}</span>
            <p>employees assigned across local geotagged areas</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
