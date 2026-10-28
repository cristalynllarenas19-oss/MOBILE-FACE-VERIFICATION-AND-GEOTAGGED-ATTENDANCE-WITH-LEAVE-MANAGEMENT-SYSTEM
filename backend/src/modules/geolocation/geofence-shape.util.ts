// Geofence shape math shared by every inside/outside check. An area is a
// circle (latitude/longitude + radiusMeters) unless it has a `boundary`: one
// or more polygons, each a ring of [latitude, longitude] vertices (drawn on
// the admin map or imported from a KML file). Being inside any one polygon
// counts as inside the area. Holes aren't supported.
//
// Kept in sync by hand with admin-web's employee-portal/geofenceShape.ts and
// employee-mobile's utils/geofence.ts — same as distanceInMeters already is.

export type GeofenceBoundary = Array<Array<[number, number]>>;

export type GeofenceSite = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  boundary?: GeofenceBoundary | null;
};

const EARTH_RADIUS_METERS = 6371000;
const MAX_TOTAL_VERTICES = 5000;

export function distanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Meters the point is outside the area's edge — zero or negative means
// inside (negative = that far in from the nearest edge).
export function distanceOutsideGeofence(latitude: number, longitude: number, site: GeofenceSite) {
  const polygons = site.boundary ?? [];
  if (polygons.length === 0) {
    return distanceInMeters(latitude, longitude, site.latitude, site.longitude) - site.radiusMeters;
  }

  // Flat local projection centred on the point itself — accurate to well
  // under a meter at work-site scale, and makes the point the origin.
  const metersPerDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
  const cosLat = Math.cos((latitude * Math.PI) / 180);
  const project = ([lat, lon]: [number, number]) => [
    (lon - longitude) * cosLat * metersPerDegree,
    (lat - latitude) * metersPerDegree,
  ];

  let nearestEdge = Infinity;
  let nearestEdgeWhileInside = Infinity;
  for (const ring of polygons) {
    const points = ring.map(project);
    let inside = false;
    let ringNearest = Infinity;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [x1, y1] = points[j];
      const [x2, y2] = points[i];
      if (y1 > 0 !== y2 > 0 && 0 < ((x2 - x1) * (0 - y1)) / (y2 - y1) + x1) inside = !inside;
      ringNearest = Math.min(ringNearest, distanceToSegment(x1, y1, x2, y2));
    }
    nearestEdge = Math.min(nearestEdge, ringNearest);
    if (inside) nearestEdgeWhileInside = Math.min(nearestEdgeWhileInside, ringNearest);
  }

  return Number.isFinite(nearestEdgeWhileInside) ? -nearestEdgeWhileInside : nearestEdge;
}

// Distance from the origin to segment (x1,y1)-(x2,y2).
function distanceToSegment(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lengthSquared));
  return Math.hypot(x1 + t * dx, y1 + t * dy);
}

// Validates a submitted boundary and drops a repeated closing vertex (KML
// rings repeat the first point last). Returns null for "no polygon" (an
// empty list), throws a user-facing message for anything malformed.
export function normalizeBoundary(value: unknown): GeofenceBoundary | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("The area boundary must be a list of polygons.");
  if (value.length === 0) return null;

  let totalVertices = 0;
  const polygons = value.map((ring) => {
    if (!Array.isArray(ring)) throw new Error("Each polygon must be a list of points.");
    const points = ring.map((point) => {
      const lat = Number(Array.isArray(point) ? point[0] : NaN);
      const lon = Number(Array.isArray(point) ? point[1] : NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Error("The area boundary has an invalid point.");
      }
      return [lat, lon] as [number, number];
    });
    const [first] = points;
    const last = points[points.length - 1];
    if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) points.pop();
    if (points.length < 3) throw new Error("Each polygon needs at least 3 points.");
    totalVertices += points.length;
    return points;
  });

  if (totalVertices > MAX_TOTAL_VERTICES) {
    throw new Error(`The area boundary has too many points (max ${MAX_TOTAL_VERTICES}). Simplify the shape first.`);
  }
  return polygons;
}

// The pin and bounding radius a polygon area is stored with, so everything
// that only needs a rough position (map pins, nearest-area sorting, the
// old circle columns) keeps working: the centre of its bounding box, and
// the distance from there to its farthest vertex.
export function boundaryCenterAndRadius(boundary: GeofenceBoundary) {
  const points = boundary.flat();
  const lats = points.map(([lat]) => lat);
  const lons = points.map(([, lon]) => lon);
  const latitude = (Math.min(...lats) + Math.max(...lats)) / 2;
  const longitude = (Math.min(...lons) + Math.max(...lons)) / 2;
  const radiusMeters = Math.ceil(
    Math.max(...points.map(([lat, lon]) => distanceInMeters(latitude, longitude, lat, lon))),
  );
  return { latitude, longitude, radiusMeters };
}
