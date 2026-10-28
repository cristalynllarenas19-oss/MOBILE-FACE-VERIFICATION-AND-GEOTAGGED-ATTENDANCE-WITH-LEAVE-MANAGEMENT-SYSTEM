import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import polygonClipping, { type Polygon as ClipPolygon } from "polygon-clipping";
import { type GeofenceBoundary, boundaryAreaSquareMeters } from "../../lib/geofenceShape";

// Building/compound outlines come from OpenFreeMap's vector tiles — the
// same OpenStreetMap data, pre-cut into CDN-cached tiles (free, no key,
// CORS-enabled). Tiles around the map view are fetched ahead of time, so a
// click is matched against outlines already in memory: instant, with no
// per-click server query (per-click Overpass lookups took many seconds and
// often failed with 502s).

export type OutlineCandidate = {
  id: string;
  name: string;
  // e.g. "Building" or "School grounds".
  kind: string;
  boundary: GeofenceBoundary;
  areaSquareMeters: number;
};

type Ring = Array<[number, number]>; // [lat, lon]
type Bbox = [number, number, number, number]; // minLat, minLon, maxLat, maxLon
type TilePart = { key: string; kind: string; ring: Ring; bbox: Bbox; areaSquareMeters: number };
type TilePoi = { name: string; rank: number; lat: number; lon: number };
type TileData = { parts: TilePart[]; pois: TilePoi[]; bounds: Bbox };

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
// The tiles' most detailed level (~0.6 m precision here) — one tile is
// about 2.4 km across around La Union.
const TILE_ZOOM = 14;
const MAX_PREFETCH_TILES = 12;
const MAX_OUTLINE_SQUARE_METERS = 1_000_000;
// Land-use areas worth offering as a compound (school grounds, a market
// or commercial lot, a factory compound…). Whole neighbourhoods and farms
// are left out.
const SKIPPED_LANDUSE = new Set([
  "residential", "farmland", "farmyard", "cemetery", "quarry", "railway", "garages",
  "allotments", "neighbourhood", "suburb", "quarter", "brownfield", "greenfield",
]);

let tileUrlTemplate: Promise<string> | null = null;
const tileRequests = new Map<string, Promise<TileData>>();
const loadedTiles = new Map<string, TileData>();

function getTileUrlTemplate() {
  // The tile URL carries a data version, so it's read from the TileJSON
  // once per session rather than hard-coded.
  tileUrlTemplate ??= fetch(TILEJSON_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`Map tiles unavailable (${response.status})`);
      return response.json() as Promise<{ tiles?: string[] }>;
    })
    .then(({ tiles }) => {
      if (!tiles?.[0]) throw new Error("Map tiles unavailable");
      return tiles[0];
    })
    .catch((error) => {
      tileUrlTemplate = null;
      throw error;
    });
  return tileUrlTemplate;
}

function tileXY(latitude: number, longitude: number) {
  const n = 2 ** TILE_ZOOM;
  const latRad = (latitude * Math.PI) / 180;
  return {
    x: Math.floor(((longitude + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
  };
}

function tileBounds(x: number, y: number): Bbox {
  const n = 2 ** TILE_ZOOM;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [lat(y + 1), (x / n) * 360 - 180, lat(y), ((x + 1) / n) * 360 - 180];
}

function ringBbox(ring: Ring): Bbox {
  const lats = ring.map(([lat]) => lat);
  const lons = ring.map(([, lon]) => lon);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}

function inBbox([minLat, minLon, maxLat, maxLon]: Bbox, lat: number, lon: number) {
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

function bboxesOverlap(a: Bbox, b: Bbox) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function ringContains(ring: Ring, lat: number, lon: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [lat1, lon1] = ring[j];
    const [lat2, lon2] = ring[i];
    if (lat1 > lat !== lat2 > lat && lon < ((lon2 - lon1) * (lat - lat1)) / (lat2 - lat1) + lon1) inside = !inside;
  }
  return inside;
}

function toRing(coordinates: number[][]): Ring {
  const ring = coordinates.map(([lon, lat]) => [lat, lon] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
  return ring;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ");
}

function decodeTile(buffer: ArrayBuffer, x: number, y: number): TileData {
  const tile = new VectorTile(new Pbf(buffer));
  const parts: TilePart[] = [];

  const addPolygons = (layerName: string, kindOf: (properties: Record<string, unknown>) => string | null) => {
    const layer = tile.layers[layerName];
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type !== 3) continue;
      const kind = kindOf(feature.properties);
      if (!kind) continue;
      const geometry = feature.toGeoJSON(x, y, TILE_ZOOM).geometry;
      // Buildings come grouped into multipolygons (by height) — each part
      // is its own building.
      const polygons =
        geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
      polygons.forEach((polygon, k) => {
        const ring = toRing(polygon[0]);
        if (ring.length < 3) return;
        parts.push({
          key: `${layerName}/${x}/${y}/${i}/${k}`,
          kind,
          ring,
          bbox: ringBbox(ring),
          areaSquareMeters: boundaryAreaSquareMeters([ring]),
        });
      });
    }
  };
  addPolygons("building", () => "Building");
  addPolygons("landuse", (properties) => {
    const landClass = String(properties.class ?? "");
    if (!landClass || SKIPPED_LANDUSE.has(landClass)) return null;
    return landClass === "school" || landClass === "university" || landClass === "college" || landClass === "hospital"
      ? `${capitalize(landClass)} grounds`
      : `${capitalize(landClass)} area`;
  });

  const pois: TilePoi[] = [];
  const poiLayer = tile.layers.poi;
  for (let i = 0; i < (poiLayer?.length ?? 0); i++) {
    const feature = poiLayer.feature(i);
    const name = feature.properties.name;
    const geometry = feature.toGeoJSON(x, y, TILE_ZOOM).geometry;
    if (typeof name !== "string" || !name.trim() || geometry.type !== "Point") continue;
    const [lon, lat] = geometry.coordinates;
    pois.push({ name: name.trim(), rank: Number(feature.properties.rank ?? 99), lat, lon });
  }

  return { parts, pois, bounds: tileBounds(x, y) };
}

function loadTile(x: number, y: number) {
  const key = `${x}/${y}`;
  let request = tileRequests.get(key);
  if (!request) {
    request = getTileUrlTemplate()
      .then((template) => fetch(template.replace("{z}", String(TILE_ZOOM)).replace("{x}", String(x)).replace("{y}", String(y))))
      .then((response) => {
        if (!response.ok) throw new Error(`Map tile unavailable (${response.status})`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const data = decodeTile(buffer, x, y);
        loadedTiles.set(key, data);
        return data;
      })
      .catch((error) => {
        tileRequests.delete(key);
        throw error;
      });
    tileRequests.set(key, request);
  }
  return request;
}

// Starts loading every tile in view, so a click there is answered from
// memory. Returns false (and loads nothing) when zoomed too far out — the
// caller should ask the admin to zoom in. Failures are left for the click
// to report.
export function prefetchOutlines(south: number, west: number, north: number, east: number) {
  const topLeft = tileXY(north, west);
  const bottomRight = tileXY(south, east);
  const count = (bottomRight.x - topLeft.x + 1) * (bottomRight.y - topLeft.y + 1);
  if (count > MAX_PREFETCH_TILES) return false;
  for (let x = topLeft.x; x <= bottomRight.x; x++) {
    for (let y = topLeft.y; y <= bottomRight.y; y++) loadTile(x, y).catch(() => undefined);
  }
  return true;
}

export function isOutlineDataLoaded(latitude: number, longitude: number) {
  const { x, y } = tileXY(latitude, longitude);
  return loadedTiles.has(`${x}/${y}`);
}

function partsAt(data: TileData, latitude: number, longitude: number) {
  return data.parts
    .filter((part) => inBbox(part.bbox, latitude, longitude) && ringContains(part.ring, latitude, longitude))
    .sort((a, b) => a.areaSquareMeters - b.areaSquareMeters);
}

// Smallest outline under the cursor, from tiles already in memory — for
// the hover highlight. Null when nothing's there or the tile isn't loaded.
export function hoverOutlineAt(latitude: number, longitude: number): Ring | null {
  const { x, y } = tileXY(latitude, longitude);
  const data = loadedTiles.get(`${x}/${y}`);
  return data ? partsAt(data, latitude, longitude)[0]?.ring ?? null : null;
}

// Every outline containing the point, smallest first (the building before
// the grounds around it). Instant when its tile was prefetched.
export async function findOutlinesAt(latitude: number, longitude: number): Promise<OutlineCandidate[]> {
  const { x, y } = tileXY(latitude, longitude);
  const data = await loadTile(x, y);
  const hits = partsAt(data, latitude, longitude).filter((part) => part.areaSquareMeters <= MAX_OUTLINE_SQUARE_METERS);

  const candidates: OutlineCandidate[] = [];
  for (const hit of hits) {
    const ring = await joinAcrossTiles(hit, data, x, y, latitude, longitude);
    const boundary: GeofenceBoundary = [ring.map(([lat, lon]) => [Number(lat.toFixed(6)), Number(lon.toFixed(6))] as [number, number])];
    const name = nameFor(ring, [data, ...neighbourData(x, y)]);
    candidates.push({
      id: hit.key,
      name: name ?? hit.kind,
      kind: hit.kind,
      boundary,
      areaSquareMeters: boundaryAreaSquareMeters(boundary),
    });
  }
  return candidates;
}

function neighbourData(x: number, y: number) {
  const result: TileData[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const data = (dx || dy) && loadedTiles.get(`${x + dx}/${y + dy}`);
      if (data) result.push(data);
    }
  }
  return result;
}

// A building that crosses a tile edge is cut into a piece per tile (each
// overlapping the next a little), so the piece under the click is joined
// with the overlapping pieces from the neighbouring tiles.
async function joinAcrossTiles(hit: TilePart, data: TileData, x: number, y: number, latitude: number, longitude: number) {
  const [minLat, minLon, maxLat, maxLon] = hit.bbox;
  const [south, west, north, east] = data.bounds;
  if (minLat >= south && maxLat <= north && minLon >= west && maxLon <= east) return hit.ring;

  const neighbours: Array<Promise<TileData | null>> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const crosses =
        (dx < 0 ? minLon < west : dx > 0 ? maxLon > east : true) &&
        (dy < 0 ? maxLat > north : dy > 0 ? minLat < south : true);
      if (crosses) neighbours.push(loadTile(x + dx, y + dy).catch(() => null));
    }
  }
  const pieces = (await Promise.all(neighbours))
    .flatMap((neighbour) => neighbour?.parts ?? [])
    .filter((part) => part.kind === hit.kind && bboxesOverlap(part.bbox, hit.bbox));
  if (pieces.length === 0) return hit.ring;

  try {
    const asClip = (ring: Ring): ClipPolygon => [ring.map(([lat, lon]) => [lon, lat] as [number, number])];
    const joined = polygonClipping.union(asClip(hit.ring), ...pieces.map((piece) => asClip(piece.ring)));
    // Of the joined shapes, the one under the click (other overlapping
    // pieces may belong to a neighbouring building).
    for (const [outer] of joined) {
      const ring = toRing(outer);
      if (ringContains(ring, latitude, longitude)) return ring;
    }
  } catch {
    // Fall back to the single tile's piece.
  }
  return hit.ring;
}

// Buildings in the tiles carry no names, so an outline is named after the
// named place (shop, school, market…) inside it — but only when there's
// exactly one. A market hall full of stalls would otherwise be named after
// whichever stall ranks first, which is worse than no name.
function nameFor(ring: Ring, tiles: TileData[]) {
  const bbox = ringBbox(ring);
  const names = new Set(
    tiles
      .flatMap((data) => data.pois)
      .filter((poi) => inBbox(bbox, poi.lat, poi.lon) && ringContains(ring, poi.lat, poi.lon))
      .map((poi) => poi.name),
  );
  return names.size === 1 ? [...names][0] : null;
}
