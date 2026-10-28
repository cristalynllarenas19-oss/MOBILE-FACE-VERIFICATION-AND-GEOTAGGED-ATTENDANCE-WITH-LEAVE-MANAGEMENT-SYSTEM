export function distanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earthRadiusMeters = 6371000;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same geofence shape math as the backend's geolocation/geofence-shape.util.ts
// (and admin-web's lib/geofenceShape.ts) — keep the three in sync. An area
// is a circle (latitude/longitude + radiusMeters) unless it has a
// `boundary`: polygons, each a ring of [latitude, longitude] points. Inside
// any one polygon counts as inside the area.

export type GeofenceBoundary = Array<Array<[number, number]>>;

export type GeofenceArea = {
  latitude: string | number;
  longitude: string | number;
  radiusMeters: string | number;
  boundary?: GeofenceBoundary | null;
};

export function isPolygonArea(area: Pick<GeofenceArea, "boundary">) {
  return Array.isArray(area.boundary) && area.boundary.length > 0;
}

// Meters the point is outside the area's edge — zero or negative means
// inside (negative = that far in from the nearest edge).
export function distanceOutsideGeofence(latitude: number, longitude: number, area: GeofenceArea) {
  const polygons = isPolygonArea(area) ? area.boundary! : [];
  if (polygons.length === 0) {
    return (
      distanceInMeters(latitude, longitude, Number(area.latitude), Number(area.longitude)) - Number(area.radiusMeters)
    );
  }

  const metersPerDegree = (Math.PI / 180) * 6371000;
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

function distanceToSegment(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lengthSquared));
  return Math.hypot(x1 + t * dx, y1 + t * dy);
}

// Short label for an area's size, used wherever "120m radius" used to be.
export function describeGeofence(area: GeofenceArea) {
  if (!isPolygonArea(area)) return `${Number(area.radiusMeters)}m radius`;
  const count = area.boundary!.length;
  return count === 1 ? "Polygon area" : `Polygon area (${count} parts)`;
}
