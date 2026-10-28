import {
  GeofenceBoundary,
  boundaryCenterAndRadius,
  distanceOutsideGeofence,
  normalizeBoundary,
} from "./geofence-shape.util";

// An L-shaped site near Agoo, ~220m x ~220m, with the top-right quarter
// cut out — the kind of shape a circle can't describe.
const lShape: GeofenceBoundary = [
  [
    [16.358, 120.353],
    [16.358, 120.355],
    [16.359, 120.355],
    [16.359, 120.354],
    [16.36, 120.354],
    [16.36, 120.353],
  ],
];
const site = { latitude: 16.359, longitude: 120.354, radiusMeters: 150, boundary: lShape };

describe("distanceOutsideGeofence", () => {
  it("keeps the circle check when there is no boundary", () => {
    expect(distanceOutsideGeofence(16.359, 120.354, { ...site, boundary: null })).toBeLessThan(0);
    expect(distanceOutsideGeofence(16.37, 120.354, { ...site, boundary: null })).toBeGreaterThan(0);
  });

  it("is inside the polygon's arms", () => {
    expect(distanceOutsideGeofence(16.3585, 120.3545, site)).toBeLessThan(0);
    expect(distanceOutsideGeofence(16.3595, 120.3535, site)).toBeLessThan(0);
  });

  it("is outside in the cut-out corner even though a circle around it would include it", () => {
    const outside = distanceOutsideGeofence(16.3597, 120.3547, site);
    expect(outside).toBeGreaterThan(0);
    // ~0.0007° of latitude past the inner edge at 16.359 ≈ 77m; nearest
    // edge is the inner vertical one ~0.0007° of longitude ≈ 75m away.
    expect(outside).toBeGreaterThan(60);
    expect(outside).toBeLessThan(90);
  });

  it("counts inside any one of several polygons", () => {
    const second: [number, number][] = [
      [16.4, 120.4],
      [16.4, 120.401],
      [16.401, 120.401],
      [16.401, 120.4],
    ];
    expect(distanceOutsideGeofence(16.4005, 120.4005, { ...site, boundary: [...lShape, second] })).toBeLessThan(0);
  });
});

describe("normalizeBoundary", () => {
  it("drops a repeated closing vertex and treats [] as no polygon", () => {
    const closed = normalizeBoundary([[[1, 1], [1, 2], [2, 2], [1, 1]]]);
    expect(closed).toEqual([[[1, 1], [1, 2], [2, 2]]]);
    expect(normalizeBoundary([])).toBeNull();
  });

  it("rejects too few or invalid points", () => {
    expect(() => normalizeBoundary([[[1, 1], [1, 2]]])).toThrow();
    expect(() => normalizeBoundary([[[1, 1], [1, 2], [95, 2]]])).toThrow();
  });
});

describe("boundaryCenterAndRadius", () => {
  it("centres on the bounding box and reaches every vertex", () => {
    const { latitude, longitude, radiusMeters } = boundaryCenterAndRadius(lShape);
    expect(latitude).toBeCloseTo(16.359, 6);
    expect(longitude).toBeCloseTo(120.354, 6);
    expect(radiusMeters).toBeGreaterThan(150);
    expect(radiusMeters).toBeLessThan(170);
  });
});
