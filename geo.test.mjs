// Run: node geo.test.mjs
import assert from 'node:assert/strict';
import { centroid, haversine, orderByNearestNeighbor, mapsRouteUrl, polygonRings } from './geo.js';

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

console.log('ok');
