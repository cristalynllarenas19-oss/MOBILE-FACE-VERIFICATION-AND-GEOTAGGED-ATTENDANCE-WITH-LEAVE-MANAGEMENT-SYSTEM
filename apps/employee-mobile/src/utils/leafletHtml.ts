import {
  LEAFLET_CSS,
  LEAFLET_JS,
  LEAFLET_MARKER_ICON,
  LEAFLET_MARKER_ICON_2X,
  LEAFLET_MARKER_SHADOW,
} from "../vendor/leafletAssets";

// Shared by every WebView map screen (WorkAreaScreen, GeotaggedAreasScreen).

// OSM's own recommended URL — the old {s} a/b/c subdomains only split the
// browser cache three ways and gain nothing over HTTP/2.
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

// Android-only: serve a tile already in the WebView's HTTP cache without
// re-checking it with the server first, so a revisited map paints at once
// instead of re-downloading the same tiles. Map tiles barely ever change.
export const MAP_WEBVIEW_CACHE_MODE = "LOAD_CACHE_ELSE_NETWORK" as const;

export const LEAFLET_ICONS = {
  marker: LEAFLET_MARKER_ICON,
  marker2x: LEAFLET_MARKER_ICON_2X,
  shadow: LEAFLET_MARKER_SHADOW,
};

// Inline Leaflet for the page <head> (bundled, see
// scripts/generate-leaflet-assets.js) instead of fetching it from a CDN on
// every map open. The default marker icon is pointed at the bundled images
// too — Leaflet otherwise derives its path from a CSS url() that resolves to
// nothing on an inline-HTML page, leaving L.marker() pins invisible.
export function leafletHeadHtml() {
  return `<style>${LEAFLET_CSS}</style>
  <script>${LEAFLET_JS}</script>
  <script>
    L.Icon.Default.imagePath = '';
    L.Icon.Default.mergeOptions({
      iconUrl: ${JSON.stringify(LEAFLET_MARKER_ICON)},
      iconRetinaUrl: ${JSON.stringify(LEAFLET_MARKER_ICON_2X)},
      shadowUrl: ${JSON.stringify(LEAFLET_MARKER_SHADOW)}
    });
  </script>`;
}
