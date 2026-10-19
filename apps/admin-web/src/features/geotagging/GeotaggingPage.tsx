import "leaflet/dist/leaflet.css";

import { Component, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Edit3, Eye, MapPin, Plus, Power, PowerOff, Save, Search, Trash2, UserMinus, Users, X } from "lucide-react";
import L from "leaflet";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import "./GeotaggingPage.css";
import { apiRequest } from "../../lib/api";
import { useActiveDepartments } from "../../lib/departments";
import { useLiveRefresh } from "../../lib/liveRefresh";
import { ConfirmDialog, type ConfirmDialogConfig } from "../../components/ui/ConfirmDialog";
import { DropdownFilter } from "../../components/ui/DropdownFilter";
import { NotificationModal, type NotificationConfig } from "../../components/ui/NotificationModal";
import { PermissionCode, permissions } from "../../types/rbac";

type EmployeeOption = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo?: string;
  // attendanceMode is the department's own setting (FIXED/FIELD/BOTH) —
  // a FIXED department can't be put on a Field area.
  department: { id: string; name: string; attendanceMode?: string };
  position?: { title: string };
  user?: { email?: string };
  attendanceMode?: string;
  employmentStatus?: string;
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
  departmentId?: string | null;
  department?: { id: string; name: string } | null;
  type?: "OFFICE" | "FIELD";
};

function isGlobalZoneLocation(location?: GeotaggedLocation | null) {
  return Boolean(location?.name && location.name.toLowerCase().includes("global zone"));
}

// What an area with nobody assigned says in place of the employee names.
// A new area starts empty and covers no one — employees can only clock in at
// areas they're assigned to — so only an actual Global Zone reads as "all".
function getUnassignedAreaLabel(location: GeotaggedLocation) {
  return isGlobalZoneLocation(location) ? "Global Zone (All Employees)" : "No employees assigned yet";
}

// Same name GeolocationService.assignDefaultOfficeLocation matches on when
// auto-assigning a new employee — kept in sync there, not derived from a
// schema flag, since WorkLocation has no isDefault column.
function isDefaultOfficeLocation(location?: GeotaggedLocation | null) {
  return location?.name === "Universal Leaf Philippines Inc. - Agoo";
}

type PlaceResult = {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
};

// Nominatim forward search — free, no API key. Its usage policy forbids
// search-as-you-type and allows at most 1 request/second, so this only runs
// from the explicit 🔍 button. Philippines-only, biased toward Agoo.
async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    countrycodes: "ph",
    limit: "5",
    viewbox: "120.20,16.50,120.55,16.15",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { "Accept-Language": "en" },
    signal,
  });
  if (!response.ok) throw new Error(`Place search failed (${response.status})`);
  const data = (await response.json()) as PlaceResult[];
  return Array.isArray(data) ? data : [];
}

// Camera-only fallback for "return to default" — the coordinates seed.ts
// gives "Universal Leaf Philippines Inc. - Agoo" (the canonical live
// record). The loaded area's own coordinates are preferred when present.
const DEFAULT_OFFICE_CENTER: [number, number] = [16.358048, 120.353511];
const DEFAULT_MAP_ZOOM = 15;

const initialForm = {
  name: "",
  latitude: "16.3222",
  longitude: "120.3656",
  radiusMeters: "120",
  departmentId: "" as string, // "" = no specific department (visible to everyone)
  employeeIds: [] as string[],
  type: "OFFICE" as "OFFICE" | "FIELD",
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

function ViewAreaEmployeesModal({
  location,
  employeeList,
  hideDepartmentFilter,
  onClose,
  onUnassign,
}: {
  location: GeotaggedLocation;
  employeeList: EmployeeOption[];
  // Supervisors are locked to their own department, so the filter is pointless.
  hideDepartmentFilter?: boolean;
  onClose: () => void;
  // Omitted for users without geolocation write access — no button shown.
  onUnassign?: (employee: EmployeeOption) => void;
}) {
  const [deptFilter, setDeptFilter] = useState("ALL");

  const isGlobal = isGlobalZoneLocation(location);

  const { departmentNames: departmentOptions } = useActiveDepartments();

  const filteredEmployees = useMemo(() => {
    if (deptFilter === "ALL") return employeeList;
    return employeeList.filter((employee) => employee.department?.name === deptFilter);
  }, [deptFilter, employeeList]);

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
            <div className="geotagging-modal-title-row">
              <h2 id="geotagging-modal-title">{location.name}</h2>
              <span
                className="geotagging-modal-count-badge"
                title={`${employeeList.length} employee${employeeList.length === 1 ? "" : "s"} assigned`}
              >
                <Users size={11} />
                {isGlobal ? "All" : employeeList.length}
              </span>
            </div>
            <p>
              {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {location.radiusMeters}m radius
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close area details">
            <X size={18} />
          </button>
        </div>

        {!hideDepartmentFilter && !isGlobal && departmentOptions.length > 1 && (
          <div className="geotagging-modal-toolbar">
            <span className="geotagging-modal-toolbar-label">
              {deptFilter !== "ALL"
                ? `Showing ${filteredEmployees.length} of ${employeeList.length}`
                : "Filter by department"}
            </span>

            <DropdownFilter
              className="modal-department-filter-wrap"
              value={deptFilter}
              onChange={setDeptFilter}
              options={departmentOptions.map((name) => ({ value: name, label: name }))}
              allLabel="All departments"
              menuLabel="Filter by department"
              ariaLabel="Filter employees by department"
            />
          </div>
        )}

        <div className="geotagging-modal-body">
          {filteredEmployees.length === 0 ? (
            <div className="employee-empty-state">
              <p>
                {isGlobal
                  ? "All employees are covered by this Global Zone."
                  : employeeList.length === 0
                    ? "No employees assigned to this area yet."
                    : "No employees match this department filter."}
              </p>
            </div>
          ) : (
            <ul className="geotagging-modal-employee-list">
              {filteredEmployees.map((employee) => (
                <li key={employee.id} className="geotagging-modal-employee-row">
                  <div className="geotagging-modal-employee-main">
                    <strong>
                      {employee.firstName} {employee.lastName}
                    </strong>
                    <span>{employee.department?.name ?? "No department"}</span>
                  </div>
                  <div className="geotagging-modal-employee-meta">
                    <span>{employee.attendanceMode === "FIELD" ? "Field" : "Non-Field"}</span>
                    {employee.position?.title && <span>{employee.position.title}</span>}
                    {employee.user?.email && <span>{employee.user.email}</span>}
                  </div>
                  {onUnassign && (
                    <button
                      type="button"
                      className="icon-button location-action-btn location-action-btn--delete"
                      onClick={() => onUnassign(employee)}
                      aria-label={`Unassign ${employee.firstName} ${employee.lastName} from ${location.name}`}
                      title="Unassign employee"
                    >
                      <UserMinus size={13} />
                    </button>
                  )}
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

function GeotaggingPageContent({
  canWrite,
  canManageAreas,
  isScopedSupervisor,
  scopedDepartmentId,
  scopedDepartmentName,
}: {
  canWrite: boolean;
  canManageAreas: boolean;
  // Supervisor gets the full-width map layout; Admin keeps the original
  // map-beside-form-and-stats layout (see the top-grid/top-right CSS).
  isScopedSupervisor: boolean;
  scopedDepartmentId?: string;
  scopedDepartmentName?: string;
}) {
  const isDepartmentLocked = Boolean(scopedDepartmentId);
  const [form, setForm] = useState(() => ({ ...initialForm, departmentId: scopedDepartmentId ?? "" }));
  const [locations, setLocations] = useState<GeotaggedLocation[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [employeeModeFilter, setEmployeeModeFilter] = useState<"ALL" | "FIELD" | "NON_FIELD">("ALL");
  const [areaSearchQuery, setAreaSearchQuery] = useState("");
  const [areaStatusFilter, setAreaStatusFilter] = useState<"active" | "inactive" | "all">("active");
  const [assignmentError, setAssignmentError] = useState("");
  const [notice, setNotice] = useState<NotificationConfig>(null);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [viewingLocationId, setViewingLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadIssues, setLoadIssues] = useState<string[]>([]);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmDialogConfig | null>(null);
  const [placeResults, setPlaceResults] = useState<PlaceResult[] | null>(null);
  const [placeSearching, setPlaceSearching] = useState(false);
  const [placeSearchMessage, setPlaceSearchMessage] = useState("");
  const lastPlaceSearchAtRef = useRef(0);
  const placeSearchRef = useRef<HTMLDivElement | null>(null);
  // Bumped on every new search and every edit of the name, so a slow
  // response for an older query is ignored instead of reopening the list.
  const placeSearchSeqRef = useRef(0);
  const placeSearchAbortRef = useRef<AbortController | null>(null);
  // True once a search has run (and no manual map click since) — only then
  // does clearing the name send the camera back to the default office.
  const placeSearchUsedRef = useRef(false);
  const placeSearchOpen = placeSearching || Boolean(placeResults?.length) || Boolean(placeSearchMessage);

  function closePlaceSearch() {
    // Also drops an in-flight search so its late response can't reopen the list.
    invalidatePlaceSearch();
  }

  // Close the floating suggestions on any click outside the search field
  // (including a manual map click), like a normal dropdown.
  useEffect(() => {
    if (!placeSearchOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (placeSearchRef.current && !placeSearchRef.current.contains(event.target as Node)) {
        closePlaceSearch();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [placeSearchOpen]);

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
          setEmployees(Array.isArray(emps) ? emps.filter((employee) => employee.employmentStatus !== "SEPARATED") : []);
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

  // Cross-referenced against `employees` (already active-only, see loadData
  // above) rather than trusting each location's embedded assignment rows —
  // an archived/separated employee's WorkLocationEmployee row can outlive
  // their archive, and would otherwise inflate this count past the real
  // active headcount (same rule the Dashboard's "Geotagged Areas" stat uses).
  const activeEmployeeIds = useMemo(() => new Set(employees.map((employee) => employee.id)), [employees]);

  const assignedEmployees = useMemo(
    () =>
      new Set(
        locations
          .flatMap(
            (location) =>
              location.employees?.map((entry) => entry.employee.id) ?? (location.employeeId ? [location.employeeId] : []),
          )
          .filter((employeeId) => activeEmployeeIds.has(employeeId)),
      ),
    [locations, activeEmployeeIds],
  );

  // Same as assignedEmployees but leaving out the area being edited — what
  // the picker means by "assigned to another area". Using assignedEmployees
  // there treated an employee just unchecked from this area as taken
  // elsewhere: greyed out, sunk to the bottom, and impossible to re-check.
  // Employees blocked from this area because they're already in another one.
  // The default area doesn't count: everyone is in it and keeps it alongside
  // one other area — and nobody is ever blocked from joining the default
  // itself (GeolocationService.claimEmployeeForArea).
  const isEditingDefaultArea = isDefaultOfficeLocation(locations.find((location) => location.id === editingLocationId));
  const assignedToOtherAreas = useMemo(
    () =>
      new Set(
        locations
          .filter(
            (location) =>
              !isEditingDefaultArea && location.id !== editingLocationId && !isDefaultOfficeLocation(location),
          )
          .flatMap(
            (location) =>
              location.employees?.map((entry) => entry.employee.id) ?? (location.employeeId ? [location.employeeId] : []),
          )
          .filter((employeeId) => activeEmployeeIds.has(employeeId)),
      ),
    [locations, activeEmployeeIds, editingLocationId, isEditingDefaultArea],
  );

  const currentLocationAssignedIds = useMemo(() => new Set(form.employeeIds), [form.employeeIds]);

  // Field areas are reserved for employees whose department is Field or
  // Both — a Fixed department is office-only. The backend enforces this too
  // (GeolocationService.assertFieldAreaRoster); this just greys them out.
  const isBlockedFromFieldArea = (employee?: EmployeeOption) =>
    form.type === "FIELD" && employee?.department?.attendanceMode === "FIXED";

  const editingLocation = useMemo(
    () => locations.find((location) => location.id === editingLocationId) ?? null,
    [editingLocationId, locations],
  );
  const editingIsGlobalZone = isGlobalZoneLocation(editingLocation);

  // Who's saved to the area being edited — the picker's sort key. Deliberately
  // the saved assignment, not the live checkboxes (form.employeeIds), so a row
  // stays put while it's checked/unchecked instead of jumping out of view.
  const savedAssignedIds = useMemo(
    () =>
      new Set(
        editingLocation
          ? editingLocation.employees?.map((entry) => entry.employee.id) ??
              (editingLocation.employeeId ? [editingLocation.employeeId] : [])
          : [],
      ),
    [editingLocation],
  );

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

  const { departments: activeDepartmentList, departmentNames: departmentOptions } = useActiveDepartments();

  // Admin-only picker for a new/edited area's owning department — sourced
  // from GET /departments (all active departments), not just whichever
  // departments happen to already have employees assigned.
  const departmentIdOptions = useMemo(
    () => activeDepartmentList.map((department) => ({ id: department.id, name: department.name })),
    [activeDepartmentList],
  );

  const employeeRowsBeforeModeFilter = useMemo(() => {
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
        // Saved to this area first, then everyone who can still be
        // assigned, then the greyed-out "already assigned to another area"
        // rows last — so the pickable employees are never buried.
        const rank = (employee: EmployeeOption) => {
          if (savedAssignedIds.has(employee.id)) return 0;
          const isAssignedElsewhere = assignedToOtherAreas.has(employee.id) && employee.attendanceMode !== "FIELD";
          return isAssignedElsewhere || isBlockedFromFieldArea(employee) ? 2 : 1;
        };
        const rankDiff = rank(a) - rank(b);
        if (rankDiff !== 0) return rankDiff;
        return `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
      });
  }, [assignedToOtherAreas, savedAssignedIds, departmentFilter, employeeSearch, employees, form.type]);

  const employeeModeCounts = useMemo(
    () => ({
      all: employeeRowsBeforeModeFilter.length,
      field: employeeRowsBeforeModeFilter.filter((employee) => employee.attendanceMode === "FIELD").length,
      nonField: employeeRowsBeforeModeFilter.filter((employee) => employee.attendanceMode !== "FIELD").length,
    }),
    [employeeRowsBeforeModeFilter],
  );

  const employeeRows = useMemo(() => {
    if (employeeModeFilter === "ALL") return employeeRowsBeforeModeFilter;
    return employeeRowsBeforeModeFilter.filter((employee) =>
      employeeModeFilter === "FIELD" ? employee.attendanceMode === "FIELD" : employee.attendanceMode !== "FIELD",
    );
  }, [employeeModeFilter, employeeRowsBeforeModeFilter]);

  // Employees in the current filtered list that can be toggled (assigned here,
  // not assigned anywhere, or a Field Technician — who may have many sites)
  const selectableEmployeeIds = useMemo(
    () =>
      employeeRows
        .filter(
          (e) =>
            currentLocationAssignedIds.has(e.id) ||
            (!isBlockedFromFieldArea(e) && (!assignedToOtherAreas.has(e.id) || e.attendanceMode === "FIELD")),
        )
        .map((e) => e.id),
    [employeeRows, currentLocationAssignedIds, assignedToOtherAreas, form.type],
  );

  const allSelectableSelected = useMemo(
    () =>
      selectableEmployeeIds.length > 0 &&
      selectableEmployeeIds.every((id) => currentLocationAssignedIds.has(id)),
    [selectableEmployeeIds, currentLocationAssignedIds],
  );

  function toggleSelectAll() {
    if (editingIsGlobalZone) return;
    if (allSelectableSelected) {
      setForm((current) => ({
        ...current,
        employeeIds: current.employeeIds.filter((id) => !selectableEmployeeIds.includes(id)),
      }));
    } else {
      const toAdd = selectableEmployeeIds.filter((id) => !currentLocationAssignedIds.has(id));
      setForm((current) => ({
        ...current,
        employeeIds: [...current.employeeIds, ...toAdd],
      }));
    }
  }

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

  const activeAreaCount = useMemo(
    () => locations.filter((location) => location.isActive !== false).length,
    [locations],
  );
  const inactiveAreaCount = useMemo(
    () => locations.filter((location) => location.isActive === false).length,
    [locations],
  );

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
        // Office areas are pinned above Field areas — an Office area is the
        // default auto-assignment target for new employees (see
        // GeolocationService.assignDefaultOfficeLocation), so it should
        // always be easy to find regardless of what it's named.
        const aOffice = a.type === "OFFICE";
        const bOffice = b.type === "OFFICE";
        if (aOffice !== bOffice) return aOffice ? -1 : 1;
        // Within Office areas, the canonical default itself is pinned first
        // — same name assignDefaultOfficeLocation matches on — so admins
        // land on it immediately instead of it sorting wherever its name
        // happens to fall alphabetically among other Office areas.
        const aDefault = a.name === "Universal Leaf Philippines Inc. - Agoo";
        const bDefault = b.name === "Universal Leaf Philippines Inc. - Agoo";
        if (aDefault !== bDefault) return aDefault ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [areaSearchQuery, areaStatusFilter, locations]);

  const areaEmptyMessage = areaSearchQuery.trim()
    ? "No areas match your search."
    : areaStatusFilter === "inactive"
      ? "No inactive areas."
      : areaStatusFilter === "active"
        ? "No active areas."
        : "No areas match this filter.";

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
      departmentId: scopedDepartmentId ?? location.departmentId ?? "",
      type: location.type ?? "OFFICE",
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
      zoom: DEFAULT_MAP_ZOOM,
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
      // A manual pin takes over from any search, so clearing the name
      // afterwards won't pull the camera away from it.
      placeSearchUsedRef.current = false;
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
    // Create the map once. Pin/circle/view updates for later coordinate
    // changes are handled by the effect below — re-running this one tore
    // down the whole map on every click (zoom reset, saved areas vanished).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const isActive = location.isActive !== false;
      const empName =
        location.employees && location.employees.length > 0
          ? location.employees.map(({ employee }) => `${employee.firstName} ${employee.lastName}`).join(", ")
          : location.employee
            ? `${location.employee.firstName} ${location.employee.lastName}`
          : getUnassignedAreaLabel(location);

      L.circle([location.latitude, location.longitude], {
        radius: location.radiusMeters,
        color: isSelected ? "#15803d" : isActive ? "#64748b" : "#cbd5e1",
        fillColor: isSelected ? "#22c55e" : isActive ? "#94a3b8" : "#e2e8f0",
        fillOpacity: isActive ? 0.22 : 0.12,
      }).addTo(layerGroup);

      const marker = L.marker([location.latitude, location.longitude], {
        icon: markerIcon,
        opacity: isActive ? 1 : 0.45,
      }).addTo(layerGroup);
      marker.bindPopup(
        `<div class="map-popup"><strong>${location.name}${isActive ? "" : " (Inactive)"}</strong><span>${empName}</span><span class="popup-radius">${location.radiusMeters}m radius</span></div>`,
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
        // A locked Supervisor's field always holds their own department; the
        // backend force-sets/verifies this regardless of what's sent here.
        departmentId: form.departmentId || null,
        type: form.type,
      };

      if (editingLocationId) {
        const updated = await apiRequest<GeotaggedLocation>(`/geolocation/locations/${editingLocationId}`, {
          method: "PATCH",
          body: JSON.stringify(areaPayload),
        });
        setLocations((current) => current.map((location) => (location.id === updated.id ? updated : location)));
        setNotice({ type: "success", title: "Location Updated", message: `"${updated.name}" was updated.` });
      } else {
        const newLoc = await apiRequest<GeotaggedLocation>("/geolocation/locations", {
          method: "POST",
          body: JSON.stringify({ ...areaPayload, employeeIds: form.employeeIds }),
        });
        setLocations((current) => [newLoc, ...current]);
        reloadLocations();
        setNotice({ type: "success", title: "Location Added", message: `"${newLoc.name}" was added.` });
      }
      startCreateMode();
    } catch (error) {
      console.error("Failed to save geotagged area", error);
      const message =
        error instanceof Error ? error.message : "Failed to save geotagged area";
      setAssignmentError(message);
    }
  }

  // Only fills the draft coordinates (same as a map click) — nothing is
  // saved until Add New Area, and the typed name is left as-is.
  async function handlePlaceSearch() {
    const query = form.name.trim();
    if (!query || placeSearching) return;
    if (Date.now() - lastPlaceSearchAtRef.current < 1000) return;
    lastPlaceSearchAtRef.current = Date.now();

    const seq = ++placeSearchSeqRef.current;
    const controller = new AbortController();
    placeSearchAbortRef.current = controller;
    placeSearchUsedRef.current = true;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setPlaceSearching(true);
    setPlaceResults(null);
    setPlaceSearchMessage("");
    try {
      const results = await searchPlaces(query, controller.signal);
      if (seq !== placeSearchSeqRef.current) return; // superseded / cleared
      setPlaceResults(results);
      if (results.length === 0) {
        setPlaceSearchMessage("No match found — click the map to pin it manually.");
      }
    } catch (error) {
      if (seq !== placeSearchSeqRef.current) return;
      console.error("Place search failed", error);
      setPlaceSearchMessage("Search unavailable — click the map instead.");
    } finally {
      window.clearTimeout(timeout);
      if (seq === placeSearchSeqRef.current) {
        placeSearchAbortRef.current = null;
        setPlaceSearching(false);
      }
    }
  }

  // Drops any in-flight search and its pending results (typing or clearing
  // the name makes them stale).
  function invalidatePlaceSearch() {
    placeSearchSeqRef.current += 1;
    placeSearchAbortRef.current?.abort();
    placeSearchAbortRef.current = null;
    setPlaceSearching(false);
    setPlaceResults(null);
    setPlaceSearchMessage("");
  }

  // Camera only: pans/zooms back to the default office. The form's
  // latitude/longitude and the draft pin are intentionally left untouched.
  function returnMapToDefaultOffice() {
    const map = mapRef.current;
    if (!map) return;
    const defaultArea = locations.find(isDefaultOfficeLocation);
    const areaLatitude = Number(defaultArea?.latitude);
    const areaLongitude = Number(defaultArea?.longitude);
    const center: [number, number] =
      Number.isFinite(areaLatitude) && Number.isFinite(areaLongitude)
        ? [areaLatitude, areaLongitude]
        : DEFAULT_OFFICE_CENTER;
    map.setView(center, DEFAULT_MAP_ZOOM, { animate: true });
  }

  function handleLocationNameChange(value: string) {
    setForm((current) => ({ ...current, name: value }));
    invalidatePlaceSearch();
    if (!value.trim() && placeSearchUsedRef.current) {
      placeSearchUsedRef.current = false;
      returnMapToDefaultOffice();
    }
  }

  function selectPlaceResult(result: PlaceResult) {
    const nextLatitude = Number(result.lat);
    const nextLongitude = Number(result.lon);
    if (!Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude)) return;
    setForm((current) => ({
      ...current,
      latitude: nextLatitude.toFixed(6),
      longitude: nextLongitude.toFixed(6),
    }));
    setPlaceResults(null);
    setPlaceSearchMessage("Pin moved — check it on the map and adjust before saving.");
  }

  // Unassigning in one area can also put employees back into the default
  // area (GeolocationService.returnToDefaultAreaIfUnassigned) — so every card
  // is re-read afterwards, not just the one that was saved.
  function reloadLocations() {
    apiRequest<GeotaggedLocation[]>("/geolocation/locations")
      .then((locs) => {
        if (Array.isArray(locs)) setLocations(locs);
      })
      .catch(() => undefined);
  }

  // Live: areas and the employee list follow changes made elsewhere (a new
  // hire landing in the default area, another admin's assignments) without
  // a reload. Only the data is refreshed — an open edit form keeps its draft.
  useLiveRefresh(() => {
    reloadLocations();
    apiRequest<EmployeeOption[]>("/employees")
      .then((emps) => {
        if (Array.isArray(emps)) setEmployees(emps.filter((employee) => employee.employmentStatus !== "SEPARATED"));
      })
      .catch(() => undefined);
  });

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
      reloadLocations();
      setNotice({ type: "success", title: "Assignments Saved", message: `Employee assignments saved for "${updated.name}".` });
      startCreateMode();
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
      tone: "danger",
      onConfirm: () => removeLocation(location),
    });
  }

  // Unassign straight from the "view employees" modal — one employee at a
  // time, applied immediately (unlike the checklist panel's Save Assignments).
  function confirmUnassignEmployee(location: GeotaggedLocation, employee: EmployeeOption) {
    const name = `${employee.firstName} ${employee.lastName}`;
    setConfirmConfig({
      title: "Unassign Employee",
      description: `Are you sure you want to unassign ${name} from "${location.name}"? They will no longer be able to record attendance in this area.`,
      confirmLabel: "Unassign",
      tone: "danger",
      onConfirm: () => unassignEmployee(location, employee),
    });
  }

  async function unassignEmployee(location: GeotaggedLocation, employee: EmployeeOption) {
    try {
      const updated = await apiRequest<GeotaggedLocation>(
        `/geolocation/locations/${location.id}/employees/${employee.id}`,
        { method: "DELETE" },
      );
      setLocations((current) => current.map((loc) => (loc.id === updated.id ? updated : loc)));
      reloadLocations();
      // Keep the assignments checklist in step if this same area is open there.
      if (editingLocationId === location.id) removeEmployeeFromCurrentLocation(employee.id);
      setNotice({
        type: "success",
        title: "Employee Unassigned",
        message: `${employee.firstName} ${employee.lastName} was unassigned from "${location.name}".`,
      });
    } catch (error) {
      console.error("Failed to unassign employee", error);
      setNotice({
        type: "error",
        title: "Couldn't Unassign Employee",
        message: error instanceof Error ? error.message : "Failed to unassign employee.",
      });
    }
  }

  async function removeLocation(location: GeotaggedLocation) {
    const id = location.id;

    try {
      await apiRequest(`/geolocation/locations/${id}`, { method: "DELETE" });
      setLocations((current) => current.filter((loc) => loc.id !== id));
      reloadLocations();
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

  async function toggleLocationActive(location: GeotaggedLocation) {
    const nextActive = !(location.isActive !== false);

    try {
      setAssignmentError("");
      const updated = await apiRequest<GeotaggedLocation>(`/geolocation/locations/${location.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: nextActive }),
      });
      setLocations((current) => current.map((loc) => (loc.id === updated.id ? updated : loc)));
    } catch (error) {
      console.error("Failed to update area status", error);
      const message = error instanceof Error ? error.message : "Failed to update area status";
      setAssignmentError(message);
    }
  }

  function confirmToggleLocationActive(location: GeotaggedLocation) {
    const isActive = location.isActive !== false;

    // Activating is non-destructive, so only ask for confirmation when
    // deactivating — that's the action with real consequences (employees
    // stop being geofenced against this area).
    if (isActive) {
      const employeeCount = getLocationEmployees(location).length;
      setConfirmConfig({
        title: "Deactivate Area",
        description:
          employeeCount > 0
            ? `Are you sure you want to deactivate "${location.name}"? Attendance geofencing will stop applying for ${employeeCount} employee${employeeCount === 1 ? "" : "s"} assigned here until it's reactivated.`
            : `Are you sure you want to deactivate "${location.name}"? It will stop being used for attendance geofencing until it's reactivated.`,
        confirmLabel: "Deactivate",
        tone: "warning",
        onConfirm: () => toggleLocationActive(location),
      });
      return;
    }

    toggleLocationActive(location);
  }

  function startCreateMode() {
    setEditingLocationId(null);
    setSelectedLocationId("");
    setForm((current) => ({
      ...initialForm,
      latitude: current.latitude,
      longitude: current.longitude,
      departmentId: scopedDepartmentId ?? "",
    }));
    setAssignmentError("");
    invalidatePlaceSearch();
    placeSearchUsedRef.current = false;
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

    // Field technicians may be assigned to many sites at once — only
    // employees on Fixed attendance are restricted to a single site.
    const isField = employeesById.get(employeeId)?.attendanceMode === "FIELD";
    if (assignedToOtherAreas.has(employeeId) && !isField) {
      return;
    }
    if (isBlockedFromFieldArea(employeesById.get(employeeId))) {
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

      <NotificationModal notification={notice} onClose={() => setNotice(null)} />

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

      {!isScopedSupervisor && (
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

            {canManageAreas && (
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
                  {editingLocationId ? (
                    <input
                      type="text"
                      value={form.name}
                      onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="e.g., Leaf buying station"
                      required
                    />
                  ) : (
                    <div className="place-search-wrap" ref={placeSearchRef}>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(event) => handleLocationNameChange(event.target.value)}
                        onKeyDown={(event) => {
                          // Enter here searches instead of triggering the
                          // browser's implicit form submit (which saved the
                          // area). Saving is only via the Add New Area button.
                          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void handlePlaceSearch();
                            return;
                          }
                          if (event.key === "Escape" && placeSearchOpen) closePlaceSearch();
                        }}
                        placeholder="e.g., Leaf buying station"
                        required
                      />
                      <button
                        type="button"
                        className="place-search-button"
                        onClick={handlePlaceSearch}
                        disabled={placeSearching || !form.name.trim()}
                        aria-label="Search this place on the map"
                        title="Search this place on the map"
                      >
                        <Search size={14} />
                      </button>

                      {/* Floats over the form (not in flow) so opening it never
                          grows the form — which used to stretch the map panel. */}
                      {placeSearchOpen && (
                        <div className="place-search-results" aria-live="polite">
                          {placeSearching && <p className="place-search-message">Searching…</p>}
                          {placeResults && placeResults.length > 0 && (
                            <ul>
                              {placeResults.map((result) => (
                                <li key={result.place_id}>
                                  <button type="button" onClick={() => selectPlaceResult(result)}>
                                    <MapPin size={13} />
                                    <span>{result.display_name}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          {placeSearchMessage && <p className="place-search-message">{placeSearchMessage}</p>}
                        </div>
                      )}
                    </div>
                  )}
                </label>

                <label>
                  Department
                  {isDepartmentLocked ? (
                    <input type="text" value={scopedDepartmentName ?? ""} disabled readOnly />
                  ) : (
                    <select
                      value={form.departmentId}
                      onChange={(event) => setForm((current) => ({ ...current, departmentId: event.target.value }))}
                    >
                      <option value="">All departments</option>
                      {departmentIdOptions.map((department) => (
                        <option key={department.id} value={department.id}>
                          {department.name}
                        </option>
                      ))}
                    </select>
                  )}
                </label>

                <label>
                  Area type
                  <select
                    value={form.type}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, type: event.target.value as "OFFICE" | "FIELD" }))
                    }
                  >
                    <option value="OFFICE">Office</option>
                    <option value="FIELD">Field</option>
                  </select>
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
                  <button className="primary-button" type="submit" disabled={loading}>
                    <Plus size={14} />
                    <span>{editingLocationId ? "Save Changes" : "Add New Area"}</span>
                  </button>
                  <button className="outline-button" type="button" onClick={startCreateMode}>
                    <span>Cancel</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      <div className={`geotagging-bottom-grid${isScopedSupervisor ? " geotagging-bottom-grid--with-map" : ""}`}>
        {isScopedSupervisor && (
          <>
            <div className="geotagging-stats geotagging-stats--row">
              <div className="geotagging-stat-card">
                <span className="stat-value">{locations.length}</span>
                <span className="stat-label">Active Zones</span>
              </div>
              <div className="geotagging-stat-card">
                <span className="stat-value">{assignedEmployees.size}</span>
                <span className="stat-label">Assigned Employees</span>
              </div>
            </div>

            <section className="geotagging-map-panel geotagging-map-panel--full" aria-label="OpenStreetMap geotagging map">
              <div className="map-panel-header">
                <MapPin size={15} className="map-panel-icon" />
                <span>Street Map - Click anywhere to pin a location</span>
              </div>
              <div ref={mapElementRef} className="geotagging-map" />
              {loading && <div className="map-loading-overlay">Loading map...</div>}
            </section>
          </>
        )}

        <section className="assigned-list" aria-label="Assigned geotagged areas">
          <div className="panel-heading">
            <div className="panel-heading-icon neutral">
              <MapPin size={14} />
            </div>
            <h3>Assigned Areas</h3>
            <span className="area-count-badge">{locations.length}</span>
          </div>

          <div className="assigned-list-toolbar">
            <div className="assigned-list-status-tabs" role="tablist" aria-label="Filter areas by status">
              <button
                type="button"
                role="tab"
                aria-selected={areaStatusFilter === "active"}
                className={`status-tab${areaStatusFilter === "active" ? " is-selected" : ""}`}
                onClick={() => setAreaStatusFilter("active")}
              >
                Active
                <span className="status-tab-count">{activeAreaCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={areaStatusFilter === "inactive"}
                className={`status-tab${areaStatusFilter === "inactive" ? " is-selected" : ""}`}
                onClick={() => setAreaStatusFilter("inactive")}
              >
                Inactive
                <span className="status-tab-count">{inactiveAreaCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={areaStatusFilter === "all"}
                className={`status-tab${areaStatusFilter === "all" ? " is-selected" : ""}`}
                onClick={() => setAreaStatusFilter("all")}
              >
                All
                <span className="status-tab-count">{locations.length}</span>
              </button>
            </div>

            <div className="area-search-wrap">
              <Search size={12} className="area-search-icon" />
              <input
                type="text"
                value={areaSearchQuery}
                onChange={(event) => setAreaSearchQuery(event.target.value)}
                placeholder="Search areas..."
                className="area-search-input"
                aria-label="Search assigned areas"
              />
            </div>
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
            ) : filteredLocations.length === 0 ? (
              <div className="empty-state">
                <Search size={28} strokeWidth={1.2} />
                <p>{areaEmptyMessage}</p>
                <small>
                  {areaSearchQuery.trim()
                    ? "Try a different area name."
                    : areaStatusFilter === "inactive"
                      ? "Deactivated areas will show up here."
                      : "Try switching the status filter."}
                </small>
              </div>
            ) : (
              filteredLocations.map((location) => {
                const locationEmployees = getLocationEmployees(location);
                const isGlobal = isGlobalZoneLocation(location);
                const isDefault = isDefaultOfficeLocation(location);
                const isActive = location.isActive !== false;
                const empName =
                  locationEmployees.length > 0
                    ? locationEmployees.map((employee) => `${employee.firstName} ${employee.lastName}`).join(", ")
                    : getUnassignedAreaLabel(location);

                return (
                  <article
                    className={`assigned-location ${selectedLocationId === location.id ? "selected" : ""}${isActive ? "" : " is-inactive"}${isDefault ? " is-default" : ""}`}
                    key={location.id}
                  >
                    <button
                      className="assigned-location-main"
                      type="button"
                      onClick={() => focusLocation(location)}
                    >
                      {isDefault ? (
                        <>
                          <div className="assigned-location-name-row">
                            <span className="assigned-location-default-badge-group">
                              <span className="assigned-location-default-icon">
                                <MapPin size={12} />
                              </span>
                              <span className="assigned-location-default-badge">Default</span>
                            </span>
                            <span
                              className="assigned-location-count"
                              title={`${locationEmployees.length} employee${locationEmployees.length === 1 ? "" : "s"} assigned`}
                            >
                              <Users size={12} />
                              {isGlobal ? "All" : locationEmployees.length}
                            </span>
                          </div>
                          <strong>{location.name}</strong>
                          <span className="assigned-location-default-summary">
                            <Users size={12} />
                            All Employees ({locationEmployees.length})
                          </span>
                        </>
                      ) : (
                        <>
                          <div className="assigned-location-name-row">
                            <strong>{location.name}</strong>
                            <span
                              className="assigned-location-count"
                              title={`${locationEmployees.length} employee${locationEmployees.length === 1 ? "" : "s"} assigned`}
                            >
                              <Users size={12} />
                              {isGlobal ? "All" : locationEmployees.length}
                            </span>
                          </div>
                          <span>{empName}</span>
                        </>
                      )}
                      <small className="assigned-location-coords">
                        <MapPin size={11} />
                        {Number(location.latitude).toFixed(5)}, {Number(location.longitude).toFixed(5)} · {location.radiusMeters}
                        m
                      </small>
                    </button>
                    <div className="assigned-location-footer">
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className={`assigned-location-status ${isActive ? "active" : "inactive"}`}>
                          {isActive ? "Active" : "Inactive"}
                        </span>
                        <span className={`assigned-location-type ${location.type === "FIELD" ? "field" : "office"}`}>
                          {location.type === "FIELD" ? "Field" : "Office"}
                        </span>
                      </div>
                      <div className="assigned-location-actions">
                        <button
                          className="icon-button location-action-btn location-action-btn--view"
                          type="button"
                          aria-label={`View details for ${location.name}`}
                          title="View details"
                          onClick={() => setViewingLocationId(location.id)}
                        >
                          <Eye size={13} />
                        </button>
                        <button
                          className="icon-button location-action-btn location-action-btn--edit"
                          type="button"
                          aria-label={canWrite ? `Manage employees for ${location.name}` : `View employees for ${location.name}`}
                          title={canWrite ? "Manage employees" : "View employees"}
                          onClick={() => focusLocation(location)}
                        >
                          <Edit3 size={13} />
                        </button>
                        {canManageAreas && (
                          <button
                            className={`icon-button location-action-btn location-action-btn--toggle${isActive ? "" : " is-inactive"}`}
                            type="button"
                            aria-label={isActive ? `Deactivate ${location.name}` : `Activate ${location.name}`}
                            title={isActive ? "Deactivate area" : "Activate area"}
                            onClick={() => confirmToggleLocationActive(location)}
                          >
                            {isActive ? <Power size={13} /> : <PowerOff size={13} />}
                          </button>
                        )}
                        {canManageAreas && (
                          <button
                            className="icon-button location-action-btn location-action-btn--delete"
                            type="button"
                            aria-label={`Remove ${location.name}`}
                            title="Remove area"
                            onClick={() => confirmRemoveLocation(location)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
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
                        placeholder="Search employees"
                      />
                    </div>
                  </label>
                  <div className="employee-assignment-label employee-department-label">
                    Department
                    {isDepartmentLocked ? (
                      <div className="department-filter-trigger locked">
                        <span>{scopedDepartmentName}</span>
                      </div>
                    ) : (
                      <DropdownFilter
                        className="department-filter-shell"
                        value={departmentFilter}
                        onChange={setDepartmentFilter}
                        options={departmentOptions.map((name) => ({ value: name, label: name }))}
                        allLabel="All departments"
                        allValue=""
                        menuLabel="Filter by department"
                        ariaLabel="Filter employees by department"
                      />
                    )}
                  </div>
                </div>
              )}

              {!editingIsGlobalZone && (
                <div className="employee-mode-row">
                  <div className="employee-mode-tabs" role="tablist" aria-label="Filter employees by attendance mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={employeeModeFilter === "ALL"}
                      className={`status-tab${employeeModeFilter === "ALL" ? " is-selected" : ""}`}
                      onClick={() => setEmployeeModeFilter("ALL")}
                    >
                      All
                      <span className="status-tab-count">{employeeModeCounts.all}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={employeeModeFilter === "FIELD"}
                      className={`status-tab${employeeModeFilter === "FIELD" ? " is-selected" : ""}`}
                      onClick={() => setEmployeeModeFilter("FIELD")}
                    >
                      Field
                      <span className="status-tab-count">{employeeModeCounts.field}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={employeeModeFilter === "NON_FIELD"}
                      className={`status-tab${employeeModeFilter === "NON_FIELD" ? " is-selected" : ""}`}
                      onClick={() => setEmployeeModeFilter("NON_FIELD")}
                    >
                      Non-Field
                      <span className="status-tab-count">{employeeModeCounts.nonField}</span>
                    </button>
                  </div>

                  {canWrite && (
                    <div className="select-all-row">
                      <button
                        type="button"
                        className={`select-all-button${allSelectableSelected ? " active" : ""}`}
                        onClick={toggleSelectAll}
                        disabled={selectableEmployeeIds.length === 0}
                        aria-label={allSelectableSelected ? "Unselect all visible employees" : "Select all visible employees"}
                      >
                        <span className="select-all-checkbox" aria-hidden="true">
                          {allSelectableSelected && <Check size={11} strokeWidth={3} />}
                        </span>
                        {allSelectableSelected ? "Unselect All" : "Select All"}
                        {selectableEmployeeIds.length > 0 && (
                          <span className="select-all-count">{selectableEmployeeIds.length}</span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {(!canWrite || editingIsGlobalZone) && (
                <small className="field-help">
                  {!canWrite
                    ? "Employees assigned to this area."
                    : "Global Zone is remove-only. You can unassign employees here, but you cannot add new ones."}
                </small>
              )}
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
                  const isAssignedElsewhere =
                    assignedToOtherAreas.has(employee.id) && !isSelected && employee.attendanceMode !== "FIELD";
                  // Still shown (and removable) when already selected — e.g.
                  // the area was just switched from Office to Field.
                  const isFixedDepartmentOnField = isBlockedFromFieldArea(employee);
                  // Everyone stays in the default area (the server refuses
                  // removing them), so a saved member can't be unticked.
                  const isLockedInDefault = isEditingDefaultArea && savedAssignedIds.has(employee.id);
                  const isDisabled =
                    isAssignedElsewhere || (isFixedDepartmentOnField && !isSelected) || isLockedInDefault;

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
                        className={`employee-checklist-item${isSelected ? " selected" : ""}${isDisabled ? " disabled" : ""}`}
                      >
                        <span className="employee-checklist-main">
                          <span className="employee-checklist-name">
                            {employee.firstName} {employee.lastName}
                          </span>
                          <span className="employee-checklist-meta">
                            {employee.department?.name}
                            {employee.attendanceMode === "FIELD" ? " - Field" : ""}
                          </span>
                          {isAssignedElsewhere && (
                            <span className="employee-assigned-note">
                              Already assigned to another geotagged area
                            </span>
                          )}
                          {isLockedInDefault && (
                            <span className="employee-assigned-note">Default area — every employee stays here</span>
                          )}
                          {isFixedDepartmentOnField && (
                            <span className="employee-assigned-note">
                              Fixed department — only Field or Both departments can be assigned to a field area
                            </span>
                          )}
                        </span>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isDisabled || (loading && employees.length === 0)}
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
              {editingLocationId ? (
                <span className="assignment-save-count">
                  {form.employeeIds.length} employee{form.employeeIds.length === 1 ? "" : "s"} selected
                </span>
              ) : (
                <span />
              )}
              <div className="assignment-save-buttons">
                <button
                  className="primary-button"
                  type="button"
                  disabled={!editingLocationId || savingAssignments}
                  onClick={handleSaveAssignments}
                >
                  <Save size={12} />
                  <span>{savingAssignments ? "Saving..." : "Save Assignments"}</span>
                </button>
                {editingLocationId && (
                  <button
                    className="outline-button"
                    type="button"
                    onClick={startCreateMode}
                  >
                    <span>Cancel</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {viewingLocation && (
        <ViewAreaEmployeesModal
          key={viewingLocation.id}
          location={viewingLocation}
          employeeList={getLocationEmployees(viewingLocation)}
          hideDepartmentFilter={isDepartmentLocked}
          onClose={() => setViewingLocationId(null)}
          onUnassign={canWrite ? (employee) => confirmUnassignEmployee(viewingLocation, employee) : undefined}
        />
      )}

      {confirmConfig && (
        <ConfirmDialog
          config={confirmConfig}
          onCancel={() => setConfirmConfig(null)}
        />
      )}
    </div>
  );
}

export function GeotaggingPage({
  user,
}: {
  user?: {
    permissions: PermissionCode[];
    roles?: string[];
    departmentId?: string;
    department?: string;
  };
}) {
  const canWrite = user?.permissions.includes(permissions.geolocationWrite) ?? true;
  // Mirrors the backend's getSupervisorDepartmentScope: a Supervisor who is
  // also an Admin (or not a Supervisor at all) gets full, unscoped access.
  const roles = user?.roles ?? [];
  const isScopedSupervisor = roles.includes("SUPERVISOR") && !roles.includes("ADMIN");
  const scopedDepartmentId = isScopedSupervisor ? user?.departmentId : undefined;
  const scopedDepartmentName = isScopedSupervisor ? user?.department : undefined;
  // A Supervisor may only assign/unassign employees on an area that already
  // exists (canWrite) — creating, editing, deleting, or activating/
  // deactivating an area is HR/Admin-only, mirroring the backend guards in
  // GeolocationController.
  const canManageAreas = canWrite && !isScopedSupervisor;

  return (
    <GeotaggingErrorBoundary>
      <GeotaggingPageContent
        canWrite={canWrite}
        canManageAreas={canManageAreas}
        isScopedSupervisor={isScopedSupervisor}
        scopedDepartmentId={scopedDepartmentId}
        scopedDepartmentName={scopedDepartmentName}
      />
    </GeotaggingErrorBoundary>
  );
}