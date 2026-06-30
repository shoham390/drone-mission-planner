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

// A one-polygon KML for a zone — Google Earth Web has no URL param to load geometry,
// so we hand it a file. ring: [[lng,lat], ...] (GeoJSON order); KML wants "lng,lat,0".
export function zoneKml(name, ring) {
  const coords = ring.map(([x, y]) => `${x},${y},0`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>${name}</name>` +
    `<Style><LineStyle><color>ffe0e022</color><width>2</width></LineStyle>` +
    `<PolyStyle><color>4de0e022</color></PolyStyle></Style>` +
    `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}` +
    `</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
}

// One Google Maps directions link covering the whole ordered route.
export function mapsRouteUrl(ordered) {
  if (!ordered.length) return '';
  const dest = ordered[ordered.length - 1];
  const wp = ordered.slice(0, -1).map((p) => `${p.lat},${p.lng}`).join('|');
  let u = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}`;
  if (wp) u += `&waypoints=${encodeURIComponent(wp)}`;
  return u;
}

// Decode KML/KMZ bytes honoring the file's real encoding so non-ASCII names
// (Hebrew, etc.) survive verbatim: UTF-16 via BOM, else the XML prolog's
// declared encoding (e.g. windows-1255), defaulting to UTF-8.
export function decodeXml(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
  const label = (head.match(/encoding=["']([\w-]+)["']/i)?.[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(label).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); } // unknown label -> utf-8
}

// Pick a human label for a feature. togeojson puts the Placemark <name> in
// props.name, but tools auto-name placemarks "Polygon 1"/"Untitled" and the real
// label is the filename (passed as fallback) or an ExtendedData property.
export function featureName(props, fallback) {
  if (!props) return fallback;
  const name = String(props.name ?? '').trim();
  const generic = !name || /^polygon\s*\d+$/i.test(name) || /^untitled/i.test(name);
  if (!generic) return name;                                // a meaningful placemark name
  const strs = Object.entries(props).filter(([k, v]) => k !== 'name' && typeof v === 'string' && v.trim());
  const heb = strs.find(([, v]) => /[֐-׿]/.test(v));      // prefer a Hebrew label
  if (heb) return heb[1].trim();
  const labelish = strs.find(([k]) => /name|title|label/i.test(k)); // else an obvious label field
  if (labelish) return labelish[1].trim();
  return fallback;                                          // generic + nothing better -> filename
}
