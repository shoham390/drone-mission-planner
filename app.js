import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { kml } from 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm';
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
// Hebrew/Arabic labels render mirrored without this bidi plugin (lazy-loaded on first RTL glyph).
maplibregl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js', true);
// import geo.js with app.js's own ?v= cache-buster so it never serves stale
const {
  centroid, polygonRings, orderByNearestNeighbor, mapsNavUrl, wazeNavUrl, zoneKml, mapsRouteUrl, decodeXml, featureName,
} = await import('./geo.js' + new URL(import.meta.url).search);

// ---- config: paste your OAuth client id from Google Cloud (see README) ----
const CLIENT_ID = '462312273267-hcab3itc0093mj9si0f76oaufvecos2t.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // per-file: no app verification needed

// ---- state ----
let accessToken = null;
let zones = []; // { id, name, lat, lng, center, corner, feature }
let numberMarkers = [];
let pointMode = 'center'; // nav-point per zone: 'center' (centroid) or 'corner' (first vertex)

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
map.addControl(new maplibregl.GeolocateControl({                                        // live position dot + follow
  positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true,
}), 'top-left');

// ---- mobile: drag the split bar to resize map vs. panel ----
// map sits at the top (column-reverse), so the pointer's Y ≈ desired map height.
const dragbar = document.getElementById('dragbar');
dragbar?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dragbar.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const h = Math.min(Math.max(ev.clientY, window.innerHeight * 0.2), window.innerHeight * 0.85);
    document.documentElement.style.setProperty('--maph', h + 'px');
    map.resize();
  };
  const up = () => { dragbar.removeEventListener('pointermove', move); dragbar.removeEventListener('pointerup', up); };
  dragbar.addEventListener('pointermove', move);
  dragbar.addEventListener('pointerup', up);
});
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
  addAirspace(); // toggleable Israel airspace reference layer
});

// ---- Israel airspace overlay: CTR / prohibited / restricted (toggle in panel) ----
// Sources: LLP/LLR = official Israel eAIP ENR 5.1 AIRAC 2025-10-02 (exact coords, arcs
// computed); CTR = OpenAIP; border = standard state boundary (reference only).
// PLANNING AID, NOT FOR CLEARANCE. No danger areas (LLD) — Israel's civil AIP lists none.
const AIR_COLOR = ['match', ['get', 'cat'], 'CTR', '#3b82f6', 'P', '#ef4444', 'R', '#f59e0b', 'border', '#22c55e', '#888'];
async function addAirspace() {
  const data = await (await fetch('./airspace.geojson' + new URL(import.meta.url).search)).json();
  map.addSource('airspace', { type: 'geojson', data });
  map.addLayer({ id: 'airspace-fill', type: 'fill', source: 'airspace', layout: { visibility: 'none' },
    paint: { 'fill-color': AIR_COLOR, 'fill-opacity': ['match', ['get', 'cat'], 'P', 0.22, 0.1] } });
  map.addLayer({ id: 'airspace-line', type: 'line', source: 'airspace', layout: { visibility: 'none' },
    paint: { 'line-color': AIR_COLOR, 'line-width': ['match', ['get', 'cat'], 'border', 2.4, 1.6] } });
  map.on('click', 'airspace-fill', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 6 }).setLngLat(e.lngLat)
      .setHTML(`<span class="coordtxt">${p.name}</span><span style="color:var(--muted)">${p.band}</span>`).addTo(map);
  });
  map.on('mouseenter', 'airspace-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'airspace-fill', () => { map.getCanvas().style.cursor = ''; });
  applyAirFilter(); // sync with any switches toggled before the async load
}

const $ = (id) => document.getElementById(id);

// one switch shows/hides all airspace categories (CTR / P / R / border) at once
const AIR_CATS = ['CTR', 'P', 'R', 'border'];
const airCats = new Set();
function applyAirFilter() {
  const f = ['in', ['get', 'cat'], ['literal', [...airCats]]];
  for (const id of ['airspace-fill', 'airspace-line']) if (map.getLayer(id)) {
    map.setFilter(id, f);
    map.setLayoutProperty(id, 'visibility', airCats.size ? 'visible' : 'none');
  }
}
$('air-all').onchange = (e) => {
  airCats.clear();
  if (e.target.checked) for (const cat of AIR_CATS) airCats.add(cat);
  applyAirFilter();
};

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
// frame a single zone's polygon (used when its list row is tapped) with a
// cinematic move: fly in AND tilt to 45° + swing the bearing 40° in ONE arc,
// so it reads as a dynamic 3D reveal. Double-click the compass to reset.
// ponytail: one flyTo, not a fitBounds+timer chain — the timer let the tilt
// interrupt a half-finished zoom on slower phones, tilting the wrong spot.
// essential: true = still animates when the OS has "reduce motion" enabled.
function flyToZone(z) {
  const b = new maplibregl.LngLatBounds();
  for (const c of z.feature.geometry.coordinates[0]) b.extend(c);
  const cam = map.cameraForBounds(b, { padding: 80, maxZoom: 16 });
  if (!cam) return; // degenerate ring — nothing to frame
  map.flyTo({ center: cam.center, zoom: cam.zoom, pitch: 45, bearing: 40,
    duration: 900, essential: true });
}
$('fit').onclick = () => fitZones();
function fitZones(opts) {
  if (!zones.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const z of zones) for (const [x, y] of z.feature.geometry.coordinates[0]) b.extend([x, y]);
  map.fitBounds(b, { padding: 40, duration: 600, ...opts });
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
  coordPin.getPopup().setHTML(
    `<span class="coordtxt">${t}</span>` +
    `<a class="navico" title="Open in Google Maps" href="${mapsNavUrl(lat, lng)}" target="_blank" rel="noopener">${MAPS_ICON}</a>` +
    `<a class="navico" title="Open in Waze" href="${wazeNavUrl(lat, lng)}" target="_blank" rel="noopener">${WAZE_ICON}</a>` +
    `<button class="copybtn" data-c="${t}">Copy</button>`
  );
  if (!coordPin.getPopup().isOpen()) coordPin.togglePopup();
}
function dropPin(lngLat) {
  if (!coordPin) {
    coordPin = new maplibregl.Marker({ color: '#22e0e0', draggable: true })
      // closeOnClick: false — otherwise the mouse "click" that fires right after the
      // long-press's mouseup reads as "clicked outside the popup" and closes it
      // instantly; our own map click handler already owns hiding the pin.
      .setPopup(new maplibregl.Popup({ closeButton: false, offset: 26, closeOnClick: false }));
    coordPin.on('drag', showCoord);
  }
  coordPin.setLngLat(lngLat).addTo(map);
  showCoord();
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
  if (coordPin) { coordPin.remove(); coordPin = null; } // tap clears the pin
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
initAuth();
accessToken = sessionStorage.getItem(TOKEN_KEY);
if (accessToken) enterApp();
else tokenClient.requestAccessToken({ prompt: '' });

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
    const corner = { lat: it.ring[0][1], lng: it.ring[0][0] }; // ponytail: first vertex = the corner
    const active = pointMode === 'corner' ? corner : center;
    const id = crypto.randomUUID();
    zones.push({
      id, name,
      lat: active.lat, lng: active.lng, center, corner,
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
    el.className = 'num-icon';
    el.textContent = i + 1;
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
  zones = []; numberMarkers = [];
  drawZones();
  $('routelink').style.display = 'none';
  $('missions').selectedIndex = 0; // so re-picking the just-cleared mission fires change
  render();
};

$('ptmode').onchange = () => {
  pointMode = $('ptmode').checked ? 'corner' : 'center'; // slider: off=center, on=corner
  for (const z of zones) { const p = z[pointMode]; z.lat = p.lat; z.lng = p.lng; }
  if (numberMarkers.length) planRoute(); else render(); // refresh markers/links to the new point
};

$('mname').value = new Date().toLocaleDateString('en-CA'); // today's date, YYYY-MM-DD

const MAPS_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#ea4335" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
const WAZE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#33ccff" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
const EARTH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#34a853" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

function render() {
  $('list').innerHTML = '';
  zones.forEach((z, i) => {
    const div = document.createElement('div');
    div.className = 'zone';
    const kml = 'data:application/vnd.google-earth.kml+xml;charset=utf-8,' +
      encodeURIComponent(zoneKml(z.name, z.feature.geometry.coordinates[0]));
    div.innerHTML =
      `<b><span class="num">${i + 1}</span> ${z.name}</b>` +
      `<a class="navico" title="Open in Google Maps" href="${mapsNavUrl(z.lat, z.lng)}" target="_blank" rel="noopener">${MAPS_ICON}</a>` +
      `<a class="navico" title="Open in Waze" href="${wazeNavUrl(z.lat, z.lng)}" target="_blank" rel="noopener">${WAZE_ICON}</a>` +
      `<a class="navico" title="Download polygon (KML)" href="${kml}" download="${z.name}.kml">${EARTH_ICON}</a>`;
    div.addEventListener('click', (e) => { // tap anywhere on the box to zoom to it
      if (e.target.closest('a')) return; // ...except the nav-icon links
      flyToZone(z);
      if (editMode) selectZone(zones.indexOf(z)); // ...and pick it for editing
    });
    $('list').appendChild(div);
  });
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
// (drive.file scope: this search only ever sees files this app created.)
async function findByName(name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and trashed=false`;
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
  try { await driveUpload(name, 'application/json', b64(JSON.stringify(doc))); btn.textContent = 'Saved ✓'; }
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
  sel.innerHTML = '<option value="" disabled selected>Load mission…</option>' +
    missions.map((f) => `<option value="${f.id}">${f.name.replace(/\.mission\.json$/, '')}</option>`).join('');
}
$('missions').onchange = () => {
  const sel = $('missions');
  if (sel.value) loadMission(sel.value, sel.selectedOptions[0].textContent);
};

// delete the selected mission — trash, not permanent: recoverable from Drive trash.
$('delmission').onclick = async () => {
  const sel = $('missions');
  // the "Load mission…" placeholder is selected — there's nothing to delete yet
  if (!sel.value) return alert('Pick the mission to delete from the list first.');
  const name = sel.options[sel.selectedIndex]?.text;
  if (!confirm(`Delete "${name}"?`)) return;
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${sel.value}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!r.ok) return alert("Couldn't delete that mission — try again.");
  refreshMissions(); // back to the placeholder — nothing auto-loads
};

async function loadMission(id, name) {
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  if (!r.ok) return alert("Couldn't load that mission — try again."); // never a silent no-op
  const doc = await r.json();
  if (name) $('mname').value = name; // so Save overwrites the loaded mission by default
  numberMarkers.forEach((m) => m.remove());
  zones = []; numberMarkers = [];
  addZonesFromGeoJSON({ features: doc.zones.map((z) => z.feature) }); // plans the route itself
}
