/**
 * GPS-camera-style stamp helpers shared between CameraScanner (live/frozen
 * preview overlay) and any attendance-photo viewer (DTR history, etc.).
 *
 * Attendance photos are stored raw/unwatermarked — mobile's CameraScanner
 * deliberately never bakes the stamp into the captured pixels (Android's
 * view-shot flattening shifts exposure), and instead expects "the timestamp
 * and location [to be] rendered as an overlay by the attendance viewer".
 * Web now matches that: the stamp is drawn as a DOM overlay wherever a
 * captured photo is shown, using the record's own stored lat/lon/timestamp,
 * not baked into the JPEG.
 */

export const TILE_SIZE = 256;
export const MAP_ZOOM = 16;

export type TileCell = { key: string; url: string; left: number; top: number };

/** Same Carto tile grid as mobile CameraScanner.buildMapGrid */
export function buildMapGrid(lat: number, lon: number, displayPx: number): TileCell[] {
  const worldSize = TILE_SIZE * Math.pow(2, MAP_ZOOM);
  const gx = ((lon + 180) / 360) * worldSize;
  const lr = (lat * Math.PI) / 180;
  const gy = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * worldSize;
  const half = displayPx / 2;
  const wl = gx - half;
  const wt = gy - half;
  const tx0 = Math.floor(wl / TILE_SIZE);
  const ty0 = Math.floor(wt / TILE_SIZE);
  const cells: TileCell[] = [];
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      const tx = tx0 + dx;
      const ty = ty0 + dy;
      cells.push({
        key: `${tx}_${ty}`,
        url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/${MAP_ZOOM}/${tx}/${ty}@2x.png`,
        left: tx * TILE_SIZE - wl,
        top:  ty * TILE_SIZE - wt,
      });
    }
  }
  return cells;
}

/** Same stamp date format as mobile */
export function formatStampDate(d: Date) {
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

/** Nominatim reverse geocoding — free, no API key */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { "Accept-Language": "en" } },
    );
    const d = await r.json() as { display_name?: string };
    return d.display_name ?? null;
  } catch {
    return null;
  }
}

/**
 * Plain-coordinates fallback for when no address is available — a failed
 * geocode (live, or the one-time server-side resolve at submission) or a
 * log row from before AttendanceLog.address existed.
 */
export function formatCoordsFallback(lat: number, lon: number) {
  return (
    `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? "N" : "S"}, ` +
    `${Math.abs(lon).toFixed(6)}°${lon >= 0 ? "E" : "W"}`
  );
}
