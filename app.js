import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { kml } from 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm';
import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/+esm';
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
  style: {
    version: 8,
    sources: {
      sat: { type: 'raster', tileSize: 256, attribution: 'Esri', maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
      dem: { type: 'raster-dem', tileSize: 256, encoding: 'terrarium', maxzoom: 15, tiles: [DEM] },
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat' },
      { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.3 } },
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
  drawZones(); // zones may have loaded before the style was ready
});

const $ = (id) => document.getElementById(id);

// push current zones into the map source + frame them
function drawZones() {
  const src = map.getSource('zones');
  if (src) src.setData({ type: 'FeatureCollection', features: zones.map((z) => z.feature) });
}
// frame a single zone's polygon (used when its list row is tapped)
function flyToZone(z) {
  const b = new maplibregl.LngLatBounds();
  for (const c of z.feature.geometry.coordinates[0]) b.extend(c);
  map.fitBounds(b, { padding: 80, maxZoom: 17, duration: 600 });
}
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
  coordPin.getPopup().setHTML(`<span class="coordtxt">${t}</span><button class="copybtn" data-c="${t}">Copy</button>`);
  if (!coordPin.getPopup().isOpen()) coordPin.togglePopup();
}
function dropPin(lngLat) {
  if (!coordPin) {
    coordPin = new maplibregl.Marker({ color: '#22e0e0', draggable: true })
      .setPopup(new maplibregl.Popup({ closeButton: false, offset: 26 }));
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
let tokenClient;
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      accessToken = resp.access_token;
      $('gate').style.display = 'none'; // enter the app
      map.resize(); // container sized after the gate hid
      $('save').disabled = false;
      $('load').disabled = false;
    },
  });
}
$('signin').onclick = () => {
  if (!tokenClient) initAuth();
  tokenClient.requestAccessToken();
};

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
    zones.push({
      id: crypto.randomUUID(), name,
      lat: active.lat, lng: active.lng, center, corner,
      feature: { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [it.ring] } },
    });
  }
  drawZones();
  fitZones();
  render();
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
$('plan').onclick = planRoute;

// wipe all loaded zones (in-memory only; saved missions & Drive files are untouched)
$('clear').onclick = () => {
  if (!zones.length || !confirm('Clear all zones from the map?')) return;
  numberMarkers.forEach((m) => m.remove());
  zones = []; numberMarkers = [];
  drawZones();
  $('routelink').style.display = 'none';
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
const EARTH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#34a853" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4.2" ry="9"/><path d="M3 12h18"/></svg>';

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
      `<a class="navico" title="Open polygon in Google Earth (KML)" href="${kml}" download="${z.name}.kml">${EARTH_ICON}</a>`;
    div.querySelector('b').addEventListener('click', () => flyToZone(z)); // tap the name to zoom to it
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

async function driveUpload(name, mimeType, base64) {
  const boundary = 'b' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, mimeType }) +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    base64 + `\r\n--${boundary}--`;
  const r = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    { method: 'POST', headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      }, body });
  if (!r.ok) throw new Error(`Drive upload failed (${r.status})`);
  return r.json();
}
const driveUploadBlob = async (file) =>
  driveUpload(file.name, file.type || 'application/octet-stream', await blobToB64(file));

// save: mission = ordered zones as a feature collection + names
$('save').onclick = async () => {
  if (!zones.length) return alert('Nothing to save.');
  const name = ($('mname').value.trim() || 'mission') + '.mission.json';
  const doc = { name, zones: zones.map((z, i) => ({ order: i + 1, name: z.name, feature: z.feature })) };
  await driveUpload(name, 'application/json', b64(JSON.stringify(doc)));
  alert(`Saved ${name} to Drive.`);
};

// list app-created mission files into the dropdown. selectFirst: auto-load the top one.
async function refreshMissions(selectFirst) {
  const r = await fetch(
    // q=trashed=false: Drive v3 lists trashed files by default, so a just-deleted
    // mission would reappear here without this filter.
    'https://www.googleapis.com/drive/v3/files?pageSize=100&q=trashed%3Dfalse&fields=files(id,name)',
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const { files = [] } = await r.json();
  const missions = files.filter((f) => f.name.endsWith('.mission.json'));
  const sel = $('missions');
  if (!missions.length) {
    sel.style.display = $('delmission').style.display = 'none';
    return alert('No saved missions found.');
  }
  // ponytail: the .mission.json suffix is the on-disk marker that identifies our
  // files among all drive.file files — keep it on disk, just hide it in the list.
  sel.innerHTML = missions.map((f) => `<option value="${f.id}">${f.name.replace(/\.mission\.json$/, '')}</option>`).join('');
  sel.style.display = $('delmission').style.display = 'inline';
  sel.onchange = () => loadMission(sel.value);
  if (selectFirst) loadMission(missions[0].id);
}
$('load').onclick = () => refreshMissions(true);

// delete the selected mission — trash, not permanent: recoverable from Drive trash.
$('delmission').onclick = async () => {
  const sel = $('missions');
  const name = sel.options[sel.selectedIndex]?.text;
  if (!sel.value || !confirm(`Delete "${name}"? It moves to your Google Drive trash.`)) return;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${sel.value}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!r.ok) return alert(`Delete failed (${r.status})`);
  refreshMissions(false); // refresh the list; don't auto-load anything
};

async function loadMission(id) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const doc = await r.json();
  numberMarkers.forEach((m) => m.remove());
  zones = []; numberMarkers = [];
  addZonesFromGeoJSON({ features: doc.zones.map((z) => z.feature) });
  $('plan').click();
}
