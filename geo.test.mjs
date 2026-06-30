// Run: node geo.test.mjs
import assert from 'node:assert/strict';
import { centroid, haversine, orderByNearestNeighbor, mapsRouteUrl, polygonRings, zoneKml, decodeXml } from './geo.js';

// polygonRings: one ring per polygon, ignores non-polygons, recurses collections
assert.equal(polygonRings({ type: 'MultiPolygon', coordinates: [[[[0, 0]]], [[[1, 1]]]] }).length, 2);
assert.equal(polygonRings({ type: 'GeometryCollection', geometries: [
  { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  { type: 'Point', coordinates: [5, 5] },
] }).length, 1);
assert.equal(polygonRings({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }).length, 0);

// centroid of a unit square (closed ring) is its center
assert.deepEqual(centroid([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), [1, 1]);

// haversine: ~111 km per degree of latitude near equator
assert.ok(Math.abs(haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.5);

// nearest-neighbor visits the closest next zone, not input order
const pts = [
  { id: 'a', lat: 0, lng: 0 },
  { id: 'c', lat: 0, lng: 5 },
  { id: 'b', lat: 0, lng: 1 },
];
assert.deepEqual(orderByNearestNeighbor(pts).map((p) => p.id), ['a', 'b', 'c']);

// route url has waypoints for the middle stop and destination = last
const url = mapsRouteUrl([
  { lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 },
]);
assert.ok(url.includes('destination=3,3'));
assert.ok(url.includes('waypoints='));

// zoneKml: GeoJSON ring [lng,lat] -> KML "lng,lat,0" coords inside a Polygon
const k = zoneKml('Z1', [[34, 32], [35, 32], [35, 33], [34, 32]]);
assert.ok(k.includes('<name>Z1</name>'));
assert.ok(k.includes('34,32,0 35,32,0 35,33,0 34,32,0'));
assert.ok(k.includes('<Polygon>'));

// decodeXml: Hebrew names survive verbatim regardless of source encoding
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
// UTF-8 (prolog declares it)
assert.ok(decodeXml(new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><n>שלום</n>')).includes('שלום'));
// windows-1255: ש=0xF9 ל=0xEC ו=0xE5 ם=0xED
assert.ok(decodeXml(concat(
  ascii('<?xml version="1.0" encoding="windows-1255"?><n>'),
  Uint8Array.from([0xf9, 0xec, 0xe5, 0xed]), ascii('</n>'))).includes('שלום'));
// UTF-16LE via BOM
{
  const s = '<?xml version="1.0"?><n>שלום</n>';
  const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) & 0xff; b[3 + i * 2] = s.charCodeAt(i) >> 8; }
  assert.ok(decodeXml(b).includes('שלום'));
}

console.log('ok');
