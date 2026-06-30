// Pure geo helpers — no DOM, no Leaflet. Tested by geo.test.mjs.

// Average of a polygon's outer-ring vertices. ring: [[lng,lat], ...] (GeoJSON order).
// ponytail: vertex-average centroid, not area-weighted — good enough for a nav pin
// on convex-ish scan zones. Swap to area-weighted only if a zone goes very concave.
export function centroid(ring) {
  const pts =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1) // drop closing duplicate vertex
      : ring;
  let lng = 0, lat = 0;
  for (const [x, y] of pts) { lng += x; lat += y; }
  return [lng / pts.length, lat / pts.length];
}

// All polygon outer-rings in a geometry — Polygon, MultiPolygon, or nested
// GeometryCollection. Non-polygon geometries (points/lines) yield none.
export function polygonRings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(polygonRings);
  return [];
}

const R = 6371; // km
export function haversine(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Greedy nearest-neighbor visiting order. points: [{id,name,lat,lng}, ...].
// If `origin` is given it's the start depot (excluded from output); else start at points[0].
// ponytail: O(n²) greedy, not optimal TSP. Fine for tens of zones — add a 2-opt
// pass or OR-Tools only if a planner complains the route zig-zags.
export function orderByNearestNeighbor(points, origin) {
  const remaining = points.slice();
  const order = [];
  let cur = origin || remaining.shift();
  if (!origin) order.push(cur);
  while (remaining.length) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(cur, remaining[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    cur = remaining.splice(best, 1)[0];
    order.push(cur);
  }
  return order;
}

export const mapsNavUrl = (lat, lng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

export const wazeNavUrl = (lat, lng) =>
  `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

// Google Earth web, camera parked over the point. 0a=ground, 1500d=eye distance (m).
export const earthNavUrl = (lat, lng) =>
  `https://earth.google.com/web/@${lat},${lng},0a,1500d,35y,0h,0t,0r`;

// One Google Maps directions link covering the whole ordered route.
export function mapsRouteUrl(ordered) {
  if (!ordered.length) return '';
  const dest = ordered[ordered.length - 1];
  const wp = ordered.slice(0, -1).map((p) => `${p.lat},${p.lng}`).join('|');
  let u = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}`;
  if (wp) u += `&waypoints=${encodeURIComponent(wp)}`;
  return u;
}
