import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { kml } from 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm';
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
// Hebrew/Arabic labels render mirrored without this bidi plugin (lazy-loaded on first RTL glyph).
maplibregl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js', true);
// import geo.js with app.js's own ?v= cache-buster so it never serves stale
const {
  centroid, polygonRings, polygonArea, orderByNearestNeighbor, mapsNavUrl, wazeNavUrl, zoneKml, mapsRouteUrl, decodeXml, featureName, haversine, esc,
} = await import('./geo.js' + new URL(import.meta.url).search);

// ---- config: paste your OAuth client id from Google Cloud (see README) ----
const CLIENT_ID = '462312273267-hcab3itc0093mj9si0f76oaufvecos2t.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // per-file: no app verification needed

// ---- state ----
let accessToken = null;
let zones = []; // { id, name, lat, lng, center, feature }
let numberMarkers = [];
let focusedId = null; // zone the camera is zoomed to; tapping it again fits back

// ---- map: MapLibre GL (WebGL) — Esri imagery + free DEM for 3D terrain + hillshade ----
// ponytail: DEM is AWS's open Terrain Tiles (terrarium), keyless. If it ever 404s,
// swap the dem source URL — terrain/hillshade just go flat, the map still works.
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const EXAG = 1.4;
const map = new maplibregl.Map({
  container: 'map', center: [34.78, 32.08], zoom: 7, pitch: 0, maxPitch: 85,
  attributionControl: false, // remove the ⓘ info button in the map corner

  style: {
    version: 8,
    // glyphs are required to render any text label; OpenFreeMap serves fonts + planet vectors keyless.
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      sat: { type: 'raster', tileSize: 256, attribution: 'Esri', maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
      dem: { type: 'raster-dem', tileSize: 256, encoding: 'terrarium', maxzoom: 15, tiles: [DEM] },
      labels: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat' },
      { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.3 } },
      // Hebrew city/town names; fall back to default name where name:he is missing.
      { id: 'city-labels', type: 'symbol', source: 'labels', 'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]],
        layout: { 'text-field': ['coalesce', ['get', 'name:he'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 12, 16] },
        paint: { 'text-color': '#fff', 'text-halo-color': '#04222a', 'text-halo-width': 1.6 } },
    ],
    terrain: { source: 'dem', exaggeration: EXAG },
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left'); // zoom + tilt/compass
const geolocate = new maplibregl.GeolocateControl({                                     // live position dot + follow
  positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true,
});
map.addControl(geolocate, 'top-left');

// ---- ROI: when on, framing a zone also fits the user's live location in view ----
// Turning the switch on kicks off live location (same as tapping the geolocate dot).
// ponytail: the checkbox is the source of truth — read .checked, no shadow flag.
let userLoc = null, roiZone = null; // roiZone = target framed by ROI, re-fit as you move
geolocate.on('geolocate', (e) => {
  userLoc = [e.coords.longitude, e.coords.latitude];
  if (document.body.classList.contains('driving')) return driveFrame(false); // driving has its own follow rules
  if (!$('roi').checked) return;
  frameRoi(500); // tracks the ping-or-polygon target; falls back to fit-all when neither
});
// POI (was ROI): the side-menu toggle and the map bar's POI button share this one path.
function applyPoi() {
  if ($('roi').checked) geolocate.trigger(); // make sure we have a live fix
  if (document.body.classList.contains('driving')) { driveFrame(true); roiNote(); return; }
  if ($('roi').checked) { if (userLoc) frameRoi(900); }
  else { map.getSource('roibox')?.setData(EMPTY_FC); hideDist(); } // drop the frame when POI is off
  roiNote();
}
document.getElementById('roi').onchange = applyPoi;
// Drop POI without re-framing: used when the user takes over the camera themselves
// (Fit, or any pan/zoom gesture). Calling applyPoi here would fight them by flying
// somewhere on the way out.
function poiOff() {
  if (!$('roi').checked) return;
  $('roi').checked = false;
  map.getSource('roibox')?.setData(EMPTY_FC);
  hideDist();
  roiNote();
}
// A user gesture on the map means manual control — let go of the POI framing. Our own
// camera moves (fitBounds/flyTo/geolocate) carry no originalEvent, so they don't trip it.
map.on('movestart', (e) => { if (e.originalEvent) poiOff(); });

// ---- mobile: driving mode IS the phone UI — no side menu, no way in or out ----
// The bar's Save/Load/Upload icons drive the desktop menu's own controls, which stay in
// the DOM behind the overlay, so save/load logic is unchanged.
const PHONE = window.matchMedia('(max-width: 640px)').matches;
if (PHONE) {
  document.getElementById('savebtn').onclick = openSaveDialog;
  document.getElementById('loadslot').onclick = openLoadDialog;
  // setDriving runs from enterApp(), not here — it asks for a location fix, and that
  // prompt must not land on top of the sign-in gate.
}
// ponytail: terrain is always on (set in the style below) — no toggle control to turn it off.
map.on('load', () => {
  map.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
    paint: { 'fill-color': '#22e0e0', 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
    paint: { 'line-color': '#22e0e0', 'line-width': 2 } });
  // dashed ghost of the as-loaded shape, drawn only for polygons that were edited
  map.addSource('orig', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'orig-line', type: 'line', source: 'orig',
    paint: { 'line-color': '#ff9800', 'line-width': 1.5, 'line-dasharray': [2, 2] } }, 'zones-line');
  // ROI: dashed line target→you. The distance chip is a DOM marker (see showDist),
  // not a symbol layer — symbols flicker/re-fade on every location update.
  map.addSource('roibox', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'roibox-line', type: 'line', source: 'roibox',
    paint: { 'line-color': '#00e5ff', 'line-width': 2, 'line-dasharray': [3, 2] } });
  // draggable vertex handles (hidden until "Edit vertices" is on)
  map.addSource('verts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'verts', type: 'circle', source: 'verts', // empty source when not editing = no handles drawn
    paint: { 'circle-radius': ['case', ['get', 'sel'], 8, 6],
      'circle-color': ['case', ['get', 'sel'], '#ff3d7f', '#00e5ff'],
      'circle-stroke-width': 2, 'circle-stroke-color': '#04070a' } });
  // near-invisible fat circle on top = a finger-sized hit target, so grabbing a
  // handle on a phone isn't hit-or-miss against a 6px dot
  map.addLayer({ id: 'verts-hit', type: 'circle', source: 'verts',
    paint: { 'circle-radius': 22, 'circle-color': '#000', 'circle-opacity': 0.01 } });
  drawZones(); // zones may have loaded before the style was ready
});

const $ = (id) => document.getElementById(id);

// iOS Safari only fires CSS :active (our press-glow) when the page has a touch
// listener — this no-op enables it globally, incl. the dynamic .zone boxes.
document.addEventListener('touchstart', () => {}, { passive: true });

// push current zones into the map source (+ the editable vertex handles)
function drawZones() {
  const src = map.getSource('zones');
  if (src) src.setData({ type: 'FeatureCollection', features: zones.map((z) => z.feature) });
  drawVerts();
  drawOrig();
}
// a zone is "edited" once its current ring differs from the snapshot taken on first touch
let showOrig = true;
const isEdited = (z) => z.origRing && JSON.stringify(z.feature.geometry.coordinates[0]) !== JSON.stringify(z.origRing);
function drawOrig() {
  const feats = showOrig ? zones.filter(isEdited).map((z) => (
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [z.origRing] } })) : [];
  map.getSource('orig')?.setData({ type: 'FeatureCollection', features: feats });
}
function drawVerts() {
  map.getSource('verts')?.setData(editMode ? vertFeatures() : { type: 'FeatureCollection', features: [] });
}

// ---- polygon editing: pick ONE polygon, then drag/add/remove/reset its corners ----
// KML rings are closed (last coord == first), so we render one handle per unique
// corner and, when the first moves/goes, keep the closing copy in step.
// Click a polygon to select it (its handles appear); tap a handle to select it
// (turns pink); Add inserts after it, Remove deletes it.
let editMode = false, dragVert = null, selVert = null, selZone = null; // selZone = index of the polygon being edited
const ringClosed = (r) => r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
const uniqCount = (r) => (ringClosed(r) ? r.length - 1 : r.length);
const isSel = (zi, vi) => !!selVert && selVert.zi === zi && selVert.vi === vi;
// snapshot the as-loaded ring the first time a zone is touched, so Reset can restore it
const ensureOrig = (z) => { if (!z.origRing) z.origRing = z.feature.geometry.coordinates[0].map((c) => c.slice()); };
function vertFeatures() {
  const fs = [];
  const zi = selZone; // handles only for the selected polygon
  if (zi == null || !zones[zi]) return { type: 'FeatureCollection', features: fs };
  const ring = zones[zi].feature.geometry.coordinates[0];
  for (let vi = 0; vi < uniqCount(ring); vi++)
    fs.push({ type: 'Feature', properties: { zi, vi, sel: isSel(zi, vi) }, geometry: { type: 'Point', coordinates: ring[vi] } });
  return { type: 'FeatureCollection', features: fs };
}
function setEdit(on) {
  editMode = on;
  if (on) { if (selZone == null || !zones[selZone]) selZone = zones.length ? 0 : null; } // show handles right away
  else { selVert = null; selZone = null; }
  $('editctrls').style.display = on ? '' : 'none';
  updateEditUI();
  drawVerts();
}
// show "select a polygon" until one is picked, then reveal the vertex tools
function updateEditUI() {
  const has = editMode && selZone != null && zones[selZone];
  $('editnote').style.display = editMode && !has ? '' : 'none';
  $('edittools').style.display = has ? '' : 'none';
}
function selectZone(zi) {
  selZone = zi; selVert = null;
  updateEditUI();
  drawVerts();
}
// insert a new vertex at the midpoint of the edge after the selected corner
function addVert() {
  if (!selVert) return;
  const z = zones[selVert.zi]; ensureOrig(z);
  const ring = z.feature.geometry.coordinates[0];
  const n = uniqCount(ring);
  const a = ring[selVert.vi], b = ring[(selVert.vi + 1) % n];
  ring.splice(selVert.vi + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  selVert = { zi: selVert.zi, vi: selVert.vi + 1 };
  drawZones();
}
// delete the selected corner (never below a triangle); re-close if the first went
function removeVert() {
  if (!selVert) return;
  const z = zones[selVert.zi]; ensureOrig(z);
  const ring = z.feature.geometry.coordinates[0];
  if (uniqCount(ring) <= 3) return;
  const vi = selVert.vi;
  if (ringClosed(ring) && vi === 0) { ring.splice(0, 1); ring[ring.length - 1] = ring[0].slice(); }
  else ring.splice(vi, 1);
  selVert = { zi: selVert.zi, vi: Math.max(0, vi - 1) };
  drawZones();
}
// restore the selected polygon to the shape it had when loaded
function resetPolys() {
  const z = zones[selZone];
  if (z && z.origRing) z.feature.geometry.coordinates[0] = z.origRing.map((c) => c.slice());
  selVert = null;
  drawZones();
}
// click a polygon (while editing) to make it the one being edited
map.on('click', 'zones-fill', (e) => {
  if (!editMode) return;
  if (map.queryRenderedFeatures(e.point, { layers: ['verts-hit'] }).length) return; // tapped a handle, not the polygon
  const zi = zones.findIndex((z) => z.id === e.features[0].properties.id);
  if (zi >= 0) selectZone(zi);
});
// grab a handle (mouse OR touch). preventDefault() is what stops the map from
// panning under the finger — without the touch* bindings, a drag panned the map.
function grabVert(e) {
  if (e.points && e.points.length > 1) return; // second finger = let the map pinch/rotate
  e.preventDefault();
  dragVert = e.features[0].properties;
  selVert = { zi: dragVert.zi, vi: dragVert.vi }; // touching a handle selects it
  cancelPress();               // don't let the long-press pin fire on a grab
  drawVerts();
  map.getCanvas().style.cursor = 'grabbing';
}
function moveVert(e) {
  if (!dragVert) return;
  const z = zones[dragVert.zi]; ensureOrig(z);
  const ring = z.feature.geometry.coordinates[0];
  const p = [e.lngLat.lng, e.lngLat.lat];
  const wasClosed = ringClosed(ring); // check before mutating — moving v0 would otherwise "open" it
  ring[dragVert.vi] = p;
  if (dragVert.vi === 0 && wasClosed) ring[ring.length - 1] = p;
  drawZones();
}
const endVert = () => { if (dragVert) { dragVert = null; map.getCanvas().style.cursor = ''; } };
map.on('mousedown', 'verts-hit', grabVert);
map.on('touchstart', 'verts-hit', grabVert);
map.on('mousemove', moveVert);
map.on('touchmove', moveVert);
map.on('mouseup', endVert);
map.on('touchend', endVert);
map.on('mouseenter', 'verts-hit', () => { if (!dragVert) map.getCanvas().style.cursor = 'grab'; });
map.on('mouseleave', 'verts-hit', () => { if (!dragVert) map.getCanvas().style.cursor = ''; });
// frame a single zone's polygon (used when its list row is tapped): fly in
// flat and north-up, no tilt or bearing swing. Double-click the compass to reset.
// ponytail: one flyTo, not a fitBounds+timer chain — the timer let the move
// interrupt a half-finished zoom on slower phones, framing the wrong spot.
// essential: true = still animates when the OS has "reduce motion" enabled.
// The ROI target [lng,lat]: a dropped map ping takes priority over the selected polygon.
function roiTarget() {
  if (coordPin) { const p = coordPin.getLngLat(); return [p.lng, p.lat]; }
  if (roiZone) return centroid(roiZone.feature.geometry.coordinates[0]);
  return null;
}
// Draw the dashed line target→you + distance chip, WITHOUT moving the camera
// (so it can update live while a ping is dragged). Clears both if there's no target.
function drawRoiLine() {
  if (!map.getLayer('roibox-line')) return; // a GPS fix can arrive before the map's load handler adds the layer
  const a = roiTarget();
  if (!userLoc || !a) { map.getSource('roibox')?.setData(EMPTY_FC); hideDist(); return; }
  const km = haversine({ lat: a[1], lng: a[0] }, { lat: userLoc[1], lng: userLoc[0] });
  const label = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  const color = km <= 1 ? '#ff9800' : '#00e5ff'; // turn orange once you're within 1 km
  map.setPaintProperty('roibox-line', 'line-color', color);
  const mid = [(a[0] + userLoc[0]) / 2, (a[1] + userLoc[1]) / 2];
  map.getSource('roibox')?.setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [a, userLoc] } },
  ] });
  showDist(mid, label, color);
}
// Padding for every framing call. In driving mode the drum, nav row and tool bar cover
// the bottom of the map, so anything framed into that strip is hidden behind them —
// reserve it instead of padding evenly, making the usable frame full width from the top
// of the map down to the top of the drum. Clamped so top + bottom can never eat the
// whole canvas (which would make fitBounds produce a garbage zoom).
function framePad(base) {
  const pad = { top: base, bottom: base, left: base, right: base };
  if (!document.body.classList.contains('driving')) return pad;
  const m = document.getElementById('map').getBoundingClientRect();
  const drum = document.getElementById('drivepickwrap').getBoundingClientRect();
  const strip = Math.round(m.bottom - drum.top) + 8; // drum top → bottom of the map
  pad.bottom = Math.min(Math.max(base, strip), Math.max(base, m.height - base - 40));
  return pad;
}
// Frame the target + live position in one frame, then draw the line. Re-called on
// each location update while driving (shorter duration) so the frame tracks you.
function frameRoi(duration) {
  if (!userLoc) return;
  const a = roiTarget();
  if (!a) return frameRoiAll(duration); // nothing to point at → fit you + all zones
  const b = new maplibregl.LngLatBounds();
  b.extend(userLoc); b.extend(a);
  // frame the whole polygon (not just its centroid) when pointing at a polygon, not a ping
  if (!coordPin && roiZone) for (const c of roiZone.feature.geometry.coordinates[0]) b.extend(c);
  map.fitBounds(b, { padding: framePad(80), maxZoom: 16, pitch: 0, bearing: 0, duration, essential: true });
  drawRoiLine();
}
// distance chip as a DOM marker: glides with your position (no symbol flicker) and
// carries a solid background so the number stays legible over any map imagery.
let distMarker;
function showDist(lngLat, text, color) {
  if (!distMarker) distMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'dist-chip' }) });
  const el = distMarker.getElement();
  el.textContent = text;
  el.style.color = color; // drives text + border via currentColor
  distMarker.setLngLat(lngLat).addTo(map);
}
function hideDist() { distMarker?.remove(); }
// ROI on but no polygon picked yet: fit your live position + every loaded zone, no target line.
function frameRoiAll(duration) {
  if (!userLoc) return;
  const b = new maplibregl.LngLatBounds();
  for (const z of zones) for (const c of z.feature.geometry.coordinates[0]) b.extend(c);
  b.extend(userLoc);
  map.fitBounds(b, { padding: framePad(80), maxZoom: 16, pitch: 0, bearing: 0, duration, essential: true });
  map.getSource('roibox')?.setData(EMPTY_FC);
  hideDist();
}
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
// flash "select a polygon" in the middle of the map for a few seconds, then fade out
let noteTimer;
function roiNote() {
  const n = $('roi-note');
  clearTimeout(noteTimer);
  if (!($('roi').checked && !roiZone && zones.length)) { n.style.display = 'none'; return; } // no zones yet → nothing to select, no nag
  n.style.display = 'block'; n.style.opacity = '1';
  noteTimer = setTimeout(() => {
    n.style.opacity = '0';
    setTimeout(() => { n.style.display = 'none'; }, 400); // wait out the fade
  }, 2500);
}
// frame just the polygon — no live position in the bounds
function framePolygon(z, duration = 900) {
  const b = new maplibregl.LngLatBounds();
  for (const c of z.feature.geometry.coordinates[0]) b.extend(c);
  const cam = map.cameraForBounds(b, { padding: framePad(80), maxZoom: 16 });
  if (!cam) return; // degenerate ring — nothing to frame
  map.flyTo({ center: cam.center, zoom: cam.zoom, pitch: 0, bearing: 0, duration, essential: true });
}
function flyToZone(z) {
  roiZone = z; // remember the target so ROI can re-frame it as the live position moves
  roiNote();
  // ROI on (with a fix): frame the target + your live position, else just the polygon.
  if ($('roi').checked && userLoc) { frameRoi(900); return; }
  framePolygon(z);
}
$('fit').onclick = () => { poiOff(); fitZones(); }; // Fit is a manual framing — POI lets go
function fitZones(opts) {
  if (!zones.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const z of zones) for (const [x, y] of z.feature.geometry.coordinates[0]) b.extend([x, y]);
  map.fitBounds(b, { padding: framePad(40), duration: 600, ...opts });
}

// CAD-style: the NavigationControl compass IS the gimbal indicator (needle tilts
// with pitch). Double-click it to snap the whole view home — north-up, flat,
// framed on the zones (or the default region when there are none).
function resetView() {
  if (zones.length) fitZones({ pitch: 0, bearing: 0 });
  else map.easeTo({ center: [34.78, 32.08], zoom: 7, pitch: 0, bearing: 0, duration: 600 });
}
const compass = map.getContainer().querySelector('.maplibregl-ctrl-compass');
if (compass) {
  compass.title = 'Orientation — double-click to reset the view';
  compass.addEventListener('dblclick', resetView);
}

// ---- long-press to drop a draggable coordinate pin (tap the popup to copy) ----
let coordPin;
function showCoord() {
  const { lng, lat } = coordPin.getLngLat();
  const t = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const box = $('coordbox');
  box.innerHTML =
    `<a class="navico" title="Open in Google Maps" href="${mapsNavUrl(lat, lng)}" target="_blank" rel="noopener">${MAPS_ICON}</a>` +
    `<a class="navico" title="Open in Waze" href="${wazeNavUrl(lat, lng)}" target="_blank" rel="noopener">${WAZE_ICON}</a>` +
    `<button class="copybtn" data-c="${t}">Copy</button>` +
    `<span class="coordtxt">${t}</span>`; // icons/actions left, coordinates right
  box.style.display = 'flex';
}
function dropPin(lngLat) {
  if (!coordPin) {
    coordPin = new maplibregl.Marker({ color: '#22e0e0', draggable: true });
    // while dragging the ping, keep the top coord box + ROI line in step (no camera move)
    coordPin.on('drag', () => { showCoord(); if ($('roi').checked) drawRoiLine(); });
  }
  coordPin.setLngLat(lngLat).addTo(map);
  showCoord();
  if ($('roi').checked && userLoc) frameRoi(600); // ping takes priority as the ROI target
}
// Press and hold ~500ms with ONE finger to drop the pin (like Google Earth/Maps).
// It never pops up during navigation: a second finger (pinch/tilt/rotate), any
// map pan/zoom, finger movement >8px, or an early release all cancel it.
// Tap the map to clear an existing pin.
let pressTimer, pressPt, justDropped = false;
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
const startPress = (e) => {
  if (dragVert) return;                                                                    // grabbing a polygon vertex
  if (e.originalEvent.touches && e.originalEvent.touches.length > 1) return cancelPress(); // multi-touch = navigation
  if (e.originalEvent.target.closest('.maplibregl-marker')) return;                        // grabbing the pin
  justDropped = false;
  pressPt = e.point;
  pressTimer = setTimeout(() => { dropPin(e.lngLat); justDropped = true; pressTimer = null; }, 500);
};
const movePress = (e) => {
  if (pressTimer && Math.hypot(e.point.x - pressPt.x, e.point.y - pressPt.y) > 8) cancelPress();
};
map.on('mousedown', startPress);
map.on('touchstart', startPress);
map.on('mousemove', movePress);
map.on('touchmove', movePress);
// release, a second finger, or the start of any pan/zoom/rotate/tilt cancels it
for (const ev of ['mouseup', 'touchend', 'touchcancel', 'dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) map.on(ev, cancelPress);
map.on('click', () => {
  if (justDropped) { justDropped = false; return; } // the long-press that just dropped it
  if (coordPin) { coordPin.remove(); coordPin = null; $('coordbox').style.display = 'none'; // tap clears the pin + box
    if ($('roi').checked && userLoc) frameRoi(600); } // ROI line reverts to the selected polygon
});
document.addEventListener('click', (e) => { // Copy button in the coordinate popup
  const btn = e.target.closest('.copybtn');
  if (!btn) return;
  navigator.clipboard?.writeText(btn.dataset.c);
  btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
});

// ---- auth ----
// Google's access tokens die after ~1h; before this, every Drive call in an
// open tab then failed (loads silently, uploads/deletes with a 401 alert).
// One shared callback serves both first sign-in and driveFetch's silent
// mid-session refreshes — it's idempotent, so re-running the sign-in UI
// bits on a refresh is harmless.
let tokenClient, tokenWaiter, refreshing;
// ponytail: cache the ~1h token in sessionStorage (tab-scoped, gone on tab close) so a
// reload inside the hour re-enters silently — no auth flash, no repeat Google popup.
const TOKEN_KEY = 'dmp_token';
function enterApp() {
  $('gate').style.display = 'none';
  map.resize(); // container sized after the gate hid
  $('save').disabled = false;
  refreshMissions(); // show the saved missions right away
  if (PHONE) setDriving(true); // phone has no menu — driving mode is the whole UI
}
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      accessToken = resp.access_token;
      sessionStorage.setItem(TOKEN_KEY, accessToken);
      enterApp();
      tokenWaiter?.(); tokenWaiter = null;
    },
    // no session/consent to refresh silently — drop the dead token and put the gate
    // back up so the fix is obvious instead of Drive calls failing quietly forever.
    error_callback: () => {
      sessionStorage.removeItem(TOKEN_KEY); accessToken = null;
      tokenWaiter?.(); tokenWaiter = null; $('gate').style.display = 'flex';
    },
  });
}
// every Drive call goes through here: on 401 (expired token) refresh silently
// and retry once. 403 (quota/permission) is real — let it surface.
async function driveFetch(url, opts = {}) {
  const call = () => fetch(url, { ...opts, headers: { Authorization: `Bearer ${accessToken}`, ...opts.headers } });
  let r = await call();
  if (r.status === 401) {
    // one silent refresh at a time: concurrent 401s share it instead of clobbering
    // tokenWaiter (which orphaned a promise -> hung Drive call -> "load needs a refresh").
    refreshing ??= new Promise((res) => { tokenWaiter = res; tokenClient.requestAccessToken({ prompt: '' }); })
      .finally(() => { refreshing = null; });
    await refreshing;
    r = await call();
  }
  return r;
}
$('signin').onclick = () => {
  if (!tokenClient) initAuth();
  tokenClient.requestAccessToken();
};
// On load: reuse a cached token (silent, no popup); an expired one just 401s on the
// first Drive call and refreshes. No cache -> silent Google reauth; if that fails
// (e.g. third-party cookies blocked) the gate stays up, same as first-time sign-in.
// The GSI library (index.html) loads async, so `google` may not exist yet when this
// module runs — calling initAuth() too early threw and left auth dead until a refresh
// warmed the cache. Wait for it. ponytail: 50ms poll; GSI has no ready event we can
// rely on for both cold + cached loads.
function startAuth() {
  initAuth();
  accessToken = sessionStorage.getItem(TOKEN_KEY);
  if (accessToken) enterApp();
  else tokenClient.requestAccessToken({ prompt: '' });
}
if (window.google?.accounts?.oauth2) startAuth();
else {
  const t = setInterval(() => {
    if (window.google?.accounts?.oauth2) { clearInterval(t); startAuth(); }
  }, 50);
}

// ---- KML/KMZ -> GeoJSON ----
async function fileToGeoJSON(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Detect KMZ by content, not extension: a zip starts with "PK". Plenty of .kmz
  // files are actually plain KML XML (renamed/exported), and some .kml are zipped.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let xmlBytes = bytes;
  if (isZip) {
    const zip = await JSZip.loadAsync(buf);
    const entry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
    if (!entry) throw new Error(`no .kml inside ${file.name}`);
    xmlBytes = await entry.async('uint8array'); // raw bytes so decodeXml can honor the encoding
  }
  const doc = new DOMParser().parseFromString(decodeXml(xmlBytes), 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid KML/XML');
  return kml(doc);
}

const ringSig = (ring) => ring.map((c) => c.join(',')).join(' ');

function addZonesFromGeoJSON(gj, fileLabel) {
  // collect (base name, ring) for every polygon; base falls back to the filename
  // when the placemark name is generic ("Polygon 1") or missing.
  // Skip rings identical to one already loaded — some files repeat the same
  // polygon twice (and re-uploading a file would otherwise double it).
  const seenSig = new Set(zones.map((z) => ringSig(z.feature.geometry.coordinates[0])));
  const items = [];
  for (const f of gj.features || []) {
    const base = featureName(f.properties, fileLabel || `Zone ${zones.length + items.length + 1}`);
    for (const ring of polygonRings(f.geometry)) {
      const sig = ringSig(ring);
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      items.push({ base, ring });
    }
  }
  // number duplicates so two "Polygon 1/2" from סכנין.kmz become "סכנין 1", "סכנין 2"
  const total = {}; for (const it of items) total[it.base] = (total[it.base] || 0) + 1;
  const seen = {};
  for (const it of items) {
    seen[it.base] = (seen[it.base] || 0) + 1;
    const name = total[it.base] > 1 ? `${it.base} ${seen[it.base]}` : it.base;
    const [clng, clat] = centroid(it.ring);
    const center = { lat: clat, lng: clng };
    const id = crypto.randomUUID();
    zones.push({
      id, name,
      lat: center.lat, lng: center.lng, center,
      feature: { type: 'Feature', properties: { name, id }, geometry: { type: 'Polygon', coordinates: [it.ring] } },
    });
  }
  drawZones();
  fitZones();
  planRoute(); // route is (re)planned automatically on every upload/load
}

// ---- upload handler: draw + push raw file to Drive ----
$('files').onchange = async (e) => {
  for (const file of e.target.files) {
    try {
      const before = zones.length;
      // filename (no extension, no bidi marks) is the label when polygons are generically named
      const label = file.name.replace(/\.(kml|kmz)$/i, '').replace(/[‎‏⁦-⁩]/g, '').trim();
      addZonesFromGeoJSON(await fileToGeoJSON(file), label);
      if (zones.length === before) alert(`${file.name}: no polygons found`);
      else if (accessToken) await driveUploadBlob(file);
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  e.target.value = '';
};

// ---- planning ----
function planRoute() {
  if (!zones.length) return;
  zones = orderByNearestNeighbor(zones);
  numberMarkers.forEach((m) => m.remove());
  numberMarkers = zones.map((z, i) => {
    const el = document.createElement('div');
    el.className = 'num-marker';
    const dot = document.createElement('div');
    dot.className = 'num-icon';
    // ponytail: center-anchored like the old circle — pin head floats over the
    // centroid rather than tip-on-point; fine for a label. Add anchor:'bottom' if
    // the tip must land exactly on the zone.
    dot.innerHTML = `<svg width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39S28 22 28 14A13 13 0 0 0 2 14C2 22 15 39 15 39Z" fill="#08302f" stroke="#22e0e0" stroke-width="2"/><text x="15" y="19" text-anchor="middle" fill="#22e0e0" font-size="13" font-weight="700" font-family="sans-serif">${i + 1}</text></svg>`;
    const tag = document.createElement('div');
    tag.className = 'area-tag';
    tag.textContent = fmtArea(polygonArea(z.feature.geometry.coordinates[0]));
    el.append(dot, tag);
    return new maplibregl.Marker({ element: el }).setLngLat([z.lng, z.lat]).addTo(map);
  });
  const link = $('routelink');
  link.href = mapsRouteUrl(zones);
  link.style.display = 'inline';
  render();
}

$('editverts').onchange = (e) => setEdit(e.target.checked);
$('origtoggle').onchange = (e) => { showOrig = e.target.checked; drawOrig(); };
$('vadd').onclick = addVert;
$('vdel').onclick = removeVert;
$('vreset').onclick = resetPolys;

// wipe all loaded zones (in-memory only; saved missions & Drive files are untouched)
$('clear').onclick = () => {
  if (!zones.length || !confirm('Clear all zones from the map?')) return;
  numberMarkers.forEach((m) => m.remove());
  zones = []; numberMarkers = []; focusedId = null;
  drawZones();
  $('routelink').style.display = 'none';
  $('missions').selectedIndex = 0; // so re-picking the just-cleared mission fires change
  render();
};

$('mname').value = new Date().toLocaleDateString('en-CA'); // today's date, YYYY-MM-DD

const MAPS_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#ea4335" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
const WAZE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#33ccff" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
const EARTH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#34a853" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

// per-polygon "mission complete" marks, persisted in localStorage so they survive
// leaving/closing the app. Keyed by mission name + zone name — no backend, no Drive
// write per tick. ponytail: renaming the mission or a zone orphans its mark; fine.
const markKey = (z) => `mark:${$('mname').value}::${z.name}`;

// polygon surface area in km². ponytail: 2dp reads "0.00 km²" below ~0.005 km²;
// bump decimals only if sub-hectare scan zones become common.
const fmtArea = (m2) => `${(m2 / 1e6).toFixed(2)} km²`;

function render() {
  $('list').innerHTML = '';
  zones.forEach((z, i) => {
    const div = document.createElement('div');
    div.className = 'zone';
    const done = z.done = localStorage.getItem(markKey(z)) === '1';
    div.classList.toggle('done', done);
    const kml = 'data:application/vnd.google-earth.kml+xml;charset=utf-8,' +
      encodeURIComponent(zoneKml(z.name, z.feature.geometry.coordinates[0]));
    div.innerHTML =
      `<b><input type="checkbox" class="donebox" title="Mark mission complete"${done ? ' checked' : ''}><span class="num">${i + 1}</span> ${esc(z.name)}<span class="area" title="Surface area">${fmtArea(polygonArea(z.feature.geometry.coordinates[0]))}</span></b>` +
      `<a class="navico" title="Open in Google Maps" href="${mapsNavUrl(z.lat, z.lng)}" target="_blank" rel="noopener">${MAPS_ICON}</a>` +
      `<a class="navico" title="Open in Waze" href="${wazeNavUrl(z.lat, z.lng)}" target="_blank" rel="noopener">${WAZE_ICON}</a>` +
      `<a class="navico" title="Download polygon (KML)" href="${kml}" download="${esc(z.name)}.kml">${EARTH_ICON}</a>`;
    div.querySelector('.donebox').onchange = (e) => {
      z.done = e.target.checked;
      if (z.done) localStorage.setItem(markKey(z), '1'); else localStorage.removeItem(markKey(z));
      div.classList.toggle('done', z.done);
    };
    div.addEventListener('click', (e) => { // tap to zoom; tap the same one again to fit back
      if (e.target.closest('a') || e.target.type === 'checkbox') return; // ...except links & the mark
      if (focusedId === z.id) { focusedId = null; fitZones(); }          // second press → back to fit-all
      else { focusedId = z.id; flyToZone(z); }
      if (editMode) selectZone(zones.indexOf(z)); // ...and pick it for editing
    });
    $('list').appendChild(div);
  });
  // phone: driving starts at sign-in, before any zones exist, so the drum rebuilds here.
  // Guarded on .driving so desktop never gets roiZone reassigned behind its back.
  if (document.body.classList.contains('driving')) resetDrum();
}

// ---- Google Drive (drive.file scope) ----
const b64 = (str) => btoa(unescape(encodeURIComponent(str)));
const blobToB64 = (blob) =>
  new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.readAsDataURL(blob);
  });

// All app files live in one Drive folder so it's tidy + gives you one shareable link.
// drive.file scope means this search only ever sees folders THIS app created, so it
// reuses the folder from a past session and can't collide with a same-named folder of
// yours. Cached per session; created on first need.
const FOLDER_NAME = 'Drone Mission Planner';
let folderId;
async function getFolderId() {
  if (folderId) return folderId;
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  const { files = [] } = await r.json();
  if (files[0]) return (folderId = files[0].id);
  const c = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return (folderId = (await c.json()).id);
}

// Same-name file already saved by this app? Update it in place instead of creating
// a duplicate — one file per name keeps the Drive folder's storage monitorable.
// Scoped to the app's folder: without `in parents` this matched ANY file this app
// ever created, so uploading a common filename silently overwrote an unrelated one.
async function findByName(name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${await getFolderId()}' in parents and trashed=false`;
  const r = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  return (await r.json()).files?.[0]?.id;
}
async function driveUpload(name, mimeType, base64) {
  const id = await findByName(name);
  const boundary = 'b' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    // parents may only be set at creation; updates keep the file where it is
    JSON.stringify(id ? { name, mimeType } : { name, mimeType, parents: [await getFolderId()] }) +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    base64 + `\r\n--${boundary}--`;
  const r = await driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files${id ? '/' + id : ''}?uploadType=multipart`,
    { method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  if (!r.ok) throw new Error('save failed, try again');
  return r.json();
}
const driveUploadBlob = async (file) =>
  driveUpload(file.name, file.type || 'application/octet-stream', await blobToB64(file));

// save: mission = ordered zones as a feature collection + names
$('save').onclick = async () => {
  if (!zones.length) return alert('Nothing to save.');
  const name = ($('mname').value.trim() || 'mission') + '.mission.json';
  const doc = { name, zones: zones.map((z, i) => ({ order: i + 1, name: z.name, feature: z.feature })) };
  // inline button feedback instead of a blocking alert — no "Drive"/filename chatter
  const btn = $('save'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  // LAST_KEY must be set here too, not just in loadMission: save a freshly uploaded KML
  // and there is no "last mission" on record, so a refresh restores nothing.
  try {
    const file = await driveUpload(name, 'application/json', b64(JSON.stringify(doc)));
    if (file?.id) localStorage.setItem(LAST_KEY, file.id);
    btn.textContent = 'Saved ✓';
  }
  catch { btn.textContent = 'Save failed'; } // never fail silently
  setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1500);
  refreshMissions(); // the new mission shows up in the list
};

// saved-missions dropdown: filled at sign-in and after save/delete, last-modified
// first. First option is a "Load mission…" placeholder, so nothing loads until
// picked; the selected option then shows which mission is on the map.
// ponytail: the .mission.json suffix is the on-disk marker that identifies our
// files among all drive.file files — keep it on disk, just hide it in the list.
async function refreshMissions() {
  const r = await driveFetch(
    // q=trashed=false: Drive v3 lists trashed files by default, so a just-deleted
    // mission would reappear here without this filter.
    'https://www.googleapis.com/drive/v3/files?pageSize=100&orderBy=modifiedTime desc&q=trashed%3Dfalse&fields=files(id,name)');
  if (!r.ok) return alert("Couldn't load your saved missions — try again.");
  const { files = [] } = await r.json();
  const missions = files.filter((f) => f.name.endsWith('.mission.json'));
  const sel = $('missions');
  sel.style.display = $('delmission').style.display = missions.length ? 'inline' : 'none';
  $('loadslot').style.opacity = missions.length ? '' : '.35'; // phone: don't show a dead icon
  sel.innerHTML = '<option value="" disabled selected>Load mission…</option>' +
    missions.map((f) => `<option value="${f.id}">${f.name.replace(/\.mission\.json$/, '')}</option>`).join('');
  autoLoadLast(sel);
}

// reopen whatever was last on the map. Once per session and only onto an empty map,
// so the refresh after a save/delete never clobbers work in progress.
const LAST_KEY = 'dmp_last_mission';
let autoLoaded = false;
async function autoLoadLast(sel) {
  if (autoLoaded || zones.length) return;
  const id = localStorage.getItem(LAST_KEY);
  // prefer the last mission on the map; if that key is gone (cleared storage, new
  // device, deleted mission) fall back to the newest saved one — the list is already
  // ordered modifiedTime desc, so the first real option is the most recent.
  const opt = (id && [...sel.options].find((o) => o.value === id))
    || [...sel.options].find((o) => o.value);
  if (!opt) return; // no saved missions at all
  sel.value = opt.value;
  await loadMission(opt.value, opt.textContent);
  // Only stop retrying once it actually worked. Marking this up front meant a first
  // attempt that failed (expired token on a refresh, dropped connection) permanently
  // disabled the restore — the next successful refreshMissions() would skip it.
  autoLoaded = zones.length > 0;
}
$('missions').onchange = () => {
  const sel = $('missions');
  if (sel.value) loadMission(sel.value, sel.selectedOptions[0].textContent);
};

// delete a mission — trash, not permanent: recoverable from Drive trash. One path for
// both the desktop 🗑 and the phone dialog's per-row delete.
async function deleteMission(id, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!r.ok) return alert("Couldn't delete that mission — try again.");
  if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
  await refreshMissions(); // back to the placeholder — nothing auto-loads
  if ($('loaddlg').open) fillMissionList(); // keep the open dialog in step
}
$('delmission').onclick = () => {
  const sel = $('missions');
  // the "Load mission…" placeholder is selected — there's nothing to delete yet
  if (!sel.value) return alert('Pick the mission to delete from the list first.');
  deleteMission(sel.value, sel.options[sel.selectedIndex]?.text);
};

// ---- phone save/load dialogs. Both read from the #missions select the desktop menu
// already maintains, so there's no second source of truth for what's saved. ----
function openSaveDialog() {
  if ($('save').disabled) return; // nothing loaded yet — same no-op as the desktop button
  $('dlgname').value = $('mname').value;
  $('savedlg').returnValue = ''; // stale 'save' from a previous open would re-fire the close handler
  $('savedlg').showModal();
  $('dlgname').select();
}
$('savedlg').addEventListener('close', () => {
  if ($('savedlg').returnValue !== 'save') return;
  const n = $('dlgname').value.trim();
  if (n) $('mname').value = n;
  $('save').click();
});
function fillMissionList() {
  const opts = [...$('missions').options].filter((o) => o.value);
  const list = $('loadlist');
  list.innerHTML = '';
  if (!opts.length) { list.innerHTML = '<p class="empty">No saved missions yet.</p>'; return; }
  for (const o of opts) {
    const row = document.createElement('div');
    row.className = 'mission-row';
    row.innerHTML = '<button class="pick"></button>' +
      '<button class="del" title="Delete mission" aria-label="Delete mission">🗑</button>';
    row.querySelector('.pick').textContent = o.textContent;
    row.querySelector('.pick').onclick = () => {
      $('loaddlg').close();
      $('missions').value = o.value; // keep the desktop select in step
      loadMission(o.value, o.textContent);
    };
    row.querySelector('.del').onclick = () => deleteMission(o.value, o.textContent);
    list.appendChild(row);
  }
}
function openLoadDialog() { fillMissionList(); $('loaddlg').showModal(); }
$('loadclose').onclick = () => $('loaddlg').close();

async function loadMission(id, name) {
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  if (!r.ok) return alert("Couldn't load that mission — try again."); // never a silent no-op
  const doc = await r.json();
  localStorage.setItem(LAST_KEY, id); // reopen this one on the next visit
  if (name) $('mname').value = name; // so Save overwrites the loaded mission by default
  numberMarkers.forEach((m) => m.remove());
  zones = []; numberMarkers = [];
  addZonesFromGeoJSON({ features: doc.zones.map((z) => z.feature) }); // plans the route itself
}

// ---- driving mode (mobile): frameless overlay, iOS-style drum picker ----
// Picking a zone in the drum sets it as the ROI target; driveFrame() then frames that
// polygon. The live position is never part of the camera bounds — see driveFrame.
let driveCur = 0, driveSettle;
// rebuild the drum and centre it on zone `i` — the single path for "zones changed"
function resetDrum(i = 0) {
  buildDrum();
  if (!zones.length) return;
  setDriveCur(i);
  $('drivepicker').scrollTop = i * 44; // 44px per row → centre the current zone
  requestAnimationFrame(drumStyle);
  // Frame it too. On the auto-load path the zones arrive AFTER setDriving() has already
  // run, so without this the camera is never pointed at them and the restored mission
  // looks like it failed to load.
  driveFrame(true);
}
function buildDrum() {
  const p = $('drivepicker');
  p.innerHTML = '<div class="spacer"></div>' + zones.map((z, i) =>
    `<div class="opt" data-i="${i}"><span class="on">${esc(z.name)}</span><span class="oi">${i + 1}</span></div>`).join('') +
    '<div class="spacer"></div>';
  p.onscroll = driveScroll;
}
// drum look: fade + tilt each row by its distance from centre; return the centred index
function drumStyle() {
  const p = $('drivepicker'), opts = [...p.querySelectorAll('.opt')];
  const mid = p.getBoundingClientRect().top + p.clientHeight / 2;
  let best = 0, bd = Infinity;
  for (const o of opts) {
    const b = o.getBoundingClientRect(), d = (b.top + b.height / 2) - mid, ad = Math.abs(d);
    o.style.opacity = Math.max(0.25, 1 - ad / 110);
    o.style.transform = `perspective(300px) rotateX(${Math.max(-58, Math.min(58, d / 1.9))}deg) scale(${Math.max(0.8, 1 - ad / 460)})`;
    if (ad < bd) { bd = ad; best = +o.dataset.i; }
  }
  return best;
}
function setDriveCur(i) {
  driveCur = i;
  $('drivepicker').querySelectorAll('.opt').forEach((o) => o.classList.toggle('cur', +o.dataset.i === i));
  const z = zones[i]; if (!z) return;
  roiZone = z; // so a POI toggle frames the right zone
  $('drivemaps').href = mapsNavUrl(z.lat, z.lng);
  $('drivewaze').href = wazeNavUrl(z.lat, z.lng);
}
function driveScroll() {
  const i = drumStyle();
  if (i !== driveCur) setDriveCur(i);
  clearTimeout(driveSettle);
  driveSettle = setTimeout(() => { if (zones[driveCur]) driveFrame(true); }, 120); // reframe once it settles
}
// driving-mode framing.
//   POI on  → frame your live position AND the selected polygon together.
//   POI off → zoom to the polygon alone, no live position in the bounds.
// Both go through framePad, so the frame sits above the drum rather than behind it.
// `force` marks an explicit action (pick a zone, toggle POI, load a mission). On a
// passive GPS tick the frame is only re-fitted while you're still more than 1.5 km out;
// inside that it stops tightening, so the view doesn't creep as you close in.
function driveFrame(force) {
  if (!document.body.classList.contains('driving')) return;
  const z = roiZone; if (!z) return;
  if (!$('roi').checked) { // POI off → the polygon only
    map.getSource('roibox')?.setData(EMPTY_FC); hideDist();
    if (force) framePolygon(z, 500);
    return;
  }
  drawRoiLine(); // no-ops into a clear when there's no fix yet
  if (!userLoc) { if (force) framePolygon(z, 500); return; } // no fix → polygon alone
  const a = roiTarget();
  const km = haversine({ lat: a[1], lng: a[0] }, { lat: userLoc[1], lng: userLoc[0] });
  if (!force && km <= 1.5) return;
  const b = new maplibregl.LngLatBounds();
  b.extend(userLoc); b.extend(a);
  for (const c of z.feature.geometry.coordinates[0]) b.extend(c);
  map.fitBounds(b, { padding: framePad(80), maxZoom: 16, pitch: 0, bearing: 0, duration: 500, essential: true });
}
let driveAnim;
function setDriving(on) {
  document.body.classList.toggle('driving', on);
  // resize + frame only once the map-height transition really ends (transitionend,
  // with a timer fallback) so the camera math uses the final canvas. Exit → re-frame
  // the last driving zone in the smaller map area above the menu.
  const mapEl = document.getElementById('map');
  const done = () => {
    clearTimeout(driveAnim); mapEl.removeEventListener('transitionend', done);
    map.resize();
    if (on) { if (zones[driveCur]) driveFrame(true); }
    else if (zones[driveCur]) flyToZone(zones[driveCur]);
  };
  clearTimeout(driveAnim);
  mapEl.addEventListener('transitionend', done);
  driveAnim = setTimeout(done, 900); // fallback if the transition never fires
  if (!on) return;
  if (!$('roi').checked) $('roi').checked = true; // driving defaults to POI on (zone + live location)
  applyPoi();
  resetDrum(Math.max(0, zones.indexOf(roiZone)));
}
