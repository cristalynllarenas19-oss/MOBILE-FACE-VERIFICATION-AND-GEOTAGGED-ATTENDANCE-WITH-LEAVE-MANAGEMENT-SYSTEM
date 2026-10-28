import type { GeofenceBoundary } from "../../lib/geofenceShape";

export type ParsedKml = {
  boundary: GeofenceBoundary;
  // First Placemark's <name>, offered as the area name when none is typed.
  name: string | null;
};

// KML coordinates are "lon,lat[,alt]" tuples separated by whitespace;
// geofence boundaries are [lat, lon].
function parseCoordinates(text: string): Array<[number, number]> {
  return text
    .trim()
    .split(/\s+/)
    .map((tuple) => tuple.split(",").map(Number))
    .filter(([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon))
    .map(([lon, lat]) => [lat, lon] as [number, number]);
}

function byLocalName(root: Document | Element, name: string) {
  // "*" namespace — KML files use several (kml/2.2, earth.google.com/kml/2.x)
  // or none at all.
  return Array.from(root.getElementsByTagNameNS("*", name));
}

// Reads every <Polygon>'s outer boundary from a KML file (Google Earth, My
// Maps, QGIS exports). Holes (<innerBoundaryIs>) are ignored. A file with no
// polygons but a traced path (<LineString> of 3+ points) uses that path as
// the outline instead. Throws a user-facing message when nothing usable is
// found.
export function parseKml(text: string): ParsedKml {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("This file isn't valid KML. Export it from Google Earth or Google My Maps as .kml and try again.");
  }

  const rings = byLocalName(doc, "Polygon").flatMap((polygon) =>
    byLocalName(polygon, "outerBoundaryIs").flatMap((outer) =>
      byLocalName(outer, "coordinates").map((node) => parseCoordinates(node.textContent ?? "")),
    ),
  );
  const paths = rings.length > 0
    ? []
    : byLocalName(doc, "LineString").flatMap((line) =>
        byLocalName(line, "coordinates").map((node) => parseCoordinates(node.textContent ?? "")),
      );

  const boundary = [...rings, ...paths]
    .map((ring) => {
      const [first] = ring;
      const last = ring[ring.length - 1];
      return ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
    })
    .filter((ring) => ring.length >= 3);

  if (boundary.length === 0) {
    throw new Error("No polygon was found in this KML file. Draw the area as a polygon in Google Earth or My Maps, then export it.");
  }

  const name = byLocalName(doc, "Placemark")
    .map((placemark) =>
      Array.from(placemark.childNodes)
        .find((child) => (child as Element).localName === "name")
        ?.textContent?.trim(),
    )
    .find(Boolean) ?? null;

  return { boundary, name };
}
