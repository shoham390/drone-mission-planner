// Locks the two non-trivial bits of the vertex editor in app.js:
// closed-ring dedup (one handle per unique corner) and dragging vertex 0
// keeping the ring closed. Run: node verts.test.mjs
import assert from 'node:assert';

const ringClosed = (r) => r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];

const handleCount = (r) => (ringClosed(r) ? r.length - 1 : r.length);

// mirrors of the ring mutations in app.js
function dragVertex(ring, vi, p) {
  const wasClosed = ringClosed(ring);
  ring[vi] = p;
  if (vi === 0 && wasClosed) ring[ring.length - 1] = p;
  return ring;
}
function addVertex(ring, vi) {
  const n = handleCount(ring);
  const a = ring[vi], b = ring[(vi + 1) % n];
  ring.splice(vi + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  return ring;
}
function removeVertex(ring, vi) {
  if (handleCount(ring) <= 3) return ring;
  if (ringClosed(ring) && vi === 0) { ring.splice(0, 1); ring[ring.length - 1] = ring[0].slice(); }
  else ring.splice(vi, 1);
  return ring;
}

// a KML square: 4 corners + closing copy of the first
const square = [[34.8, 32.1], [34.83, 32.1], [34.83, 32.13], [34.8, 32.13], [34.8, 32.1]];
assert.equal(handleCount(square), 4, 'closed ring shows one handle per unique corner');

// dragging corner 0 must move the closing copy too, so the ring stays closed
const r = square.map((c) => c.slice());
dragVertex(r, 0, [34.79, 32.09]);
assert.deepEqual(r[0], [34.79, 32.09]);
assert.deepEqual(r[r.length - 1], [34.79, 32.09], 'closing vertex tracks vertex 0');
assert.ok(ringClosed(r), 'ring still closed after dragging vertex 0');

// dragging a middle corner leaves the ring closed and only moves that corner
const r2 = square.map((c) => c.slice());
dragVertex(r2, 2, [34.9, 32.2]);
assert.deepEqual(r2[2], [34.9, 32.2]);
assert.ok(ringClosed(r2), 'ring still closed after dragging a middle vertex');
assert.deepEqual(r2[0], [34.8, 32.1], 'other corners untouched');

// add a vertex after corner 0: new midpoint between corner 0 and 1, ring stays closed
const r3 = square.map((c) => c.slice());
addVertex(r3, 0);
assert.equal(handleCount(r3), 5, 'add grows the corner count by one');
assert.deepEqual(r3[1], [34.815, 32.1], 'new vertex at the edge midpoint');
assert.ok(ringClosed(r3), 'ring still closed after add');

// add after the LAST corner inserts before the closing copy (edge back to corner 0)
const r4 = square.map((c) => c.slice());
addVertex(r4, 3);
assert.equal(handleCount(r4), 5);
assert.deepEqual(r4[4], [34.8, 32.115], 'midpoint of last edge back to start');
assert.ok(ringClosed(r4), 'ring still closed after wrap-around add');

// remove a middle corner: ring shrinks, stays closed
const r5 = square.map((c) => c.slice());
removeVertex(r5, 1);
assert.equal(handleCount(r5), 3);
assert.ok(ringClosed(r5), 'ring still closed after removing a middle corner');

// remove corner 0: the closing copy must follow the new first corner
const r6 = square.map((c) => c.slice());
removeVertex(r6, 0);
assert.equal(handleCount(r6), 3);
assert.deepEqual(r6[r6.length - 1], r6[0], 'closing copy re-tracks the new first corner');
assert.ok(ringClosed(r6));

// never let a polygon drop below a triangle
const tri = [[0, 0], [1, 0], [0, 1], [0, 0]];
removeVertex(tri, 1);
assert.equal(handleCount(tri), 3, 'a triangle refuses to lose a corner');

console.log('ok');
