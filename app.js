import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { kml } from 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm';
import {
  centroid, polygonRings, orderByNearestNeighbor, mapsNavUrl, wazeNavUrl, mapsRouteUrl,
} from './geo.js';

// ---- config: paste your OAuth client id from Google Cloud (see README) ----
const CLIENT_ID = '462312273267-hcab3itc0093mj9si0f76oaufvecos2t.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // per-file: no app verification needed

// ---- state ----
let accessToken = null;
let zones = []; // { id, name, layer, lat, lng, center, corner, feature }
let numberLayers = [];
let pointMode = 'center'; // nav-point per zone: 'center' (centroid) or 'corner' (first vertex)
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Esri', maxZoom: 19 });
const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap', maxZoom: 19 });
const map = L.map('map', { layers: [satellite] }).setView([32.08, 34.78], 8);
L.control.layers({ Satellite: satellite, Street: street }).addTo(map);

const $ = (id) => document.getElementById(id);

// ---- auth ----
let tokenClient;
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      accessToken = resp.access_token;
      $('gate').style.display = 'none'; // enter the app
      map.invalidateSize();
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
  let xmlText;
  if (isZip) {
    const zip = await JSZip.loadAsync(buf);
    const entry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
    if (!entry) throw new Error(`no .kml inside ${file.name}`);
    xmlText = await entry.async('string');
  } else {
    xmlText = new TextDecoder().decode(bytes); // strips a UTF-8 BOM if present
  }
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid KML/XML');
  return kml(doc);
}

function addZonesFromGeoJSON(gj) {
  for (const f of gj.features || []) {
    const rings = polygonRings(f.geometry); // one zone per polygon — handles MultiPolygon/collections
    const base = (f.properties && f.properties.name) || `Zone ${zones.length + 1}`;
    rings.forEach((ring, i) => {
      const [clng, clat] = centroid(ring);
      const center = { lat: clat, lng: clng };
      const corner = { lat: ring[0][1], lng: ring[0][0] }; // ponytail: first vertex = the corner
      const active = pointMode === 'corner' ? corner : center;
      const layer = L.polygon(ring.map(([x, y]) => [y, x]), {
        color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.18,
      }).addTo(map);
      zones.push({
        id: crypto.randomUUID(),
        name: rings.length > 1 ? `${base} (${i + 1})` : base,
        layer, lat: active.lat, lng: active.lng, center, corner,
        feature: { type: 'Feature', properties: { name: base }, geometry: { type: 'Polygon', coordinates: [ring] } },
      });
    });
  }
  if (zones.length) {
    map.invalidateSize(); // container may have sized after map init (panels/tabs)
    map.fitBounds(L.featureGroup(zones.map((z) => z.layer)).getBounds().pad(0.1));
  }
  render();
}

// ---- upload handler: draw + push raw file to Drive ----
$('files').onchange = async (e) => {
  for (const file of e.target.files) {
    try {
      const before = zones.length;
      addZonesFromGeoJSON(await fileToGeoJSON(file));
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
  numberLayers.forEach((l) => map.removeLayer(l));
  numberLayers = zones.map((z, i) =>
    L.marker([z.lat, z.lng], {
      icon: L.divIcon({ className: 'num-icon', html: i + 1, iconSize: [24, 24] }),
    }).addTo(map));
  const link = $('routelink');
  link.href = mapsRouteUrl(zones);
  link.style.display = 'inline';
  render();
}
$('plan').onclick = planRoute;

$('ptmode').onclick = () => {
  pointMode = pointMode === 'center' ? 'corner' : 'center';
  $('ptmode').textContent = pointMode === 'corner' ? '📐 Pin: Corner' : '📍 Pin: Center';
  for (const z of zones) { const p = z[pointMode]; z.lat = p.lat; z.lng = p.lng; }
  if (numberLayers.length) planRoute(); else render(); // refresh markers/links to the new point
};

$('mname').value = new Date().toLocaleDateString('en-CA'); // today's date, YYYY-MM-DD

function render() {
  $('list').innerHTML = '';
  zones.forEach((z, i) => {
    const div = document.createElement('div');
    div.className = 'zone';
    div.innerHTML =
      `<b><span class="num">${i + 1}</span> ${z.name}</b>` +
      `<a href="${mapsNavUrl(z.lat, z.lng)}" target="_blank" rel="noopener">Google Maps</a>` +
      `<a href="${wazeNavUrl(z.lat, z.lng)}" target="_blank" rel="noopener">Waze</a>`;
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

// load: list app-created files, filter missions, restore the picked one
$('load').onclick = async () => {
  const r = await fetch(
    'https://www.googleapis.com/drive/v3/files?pageSize=100&fields=files(id,name)',
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const { files = [] } = await r.json();
  const missions = files.filter((f) => f.name.endsWith('.mission.json'));
  if (!missions.length) return alert('No saved missions found.');
  const sel = $('missions');
  sel.innerHTML = missions.map((f) => `<option value="${f.id}">${f.name}</option>`).join('');
  sel.style.display = 'inline';
  sel.onchange = () => loadMission(sel.value);
  loadMission(missions[0].id);
};

async function loadMission(id) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const doc = await r.json();
  zones.forEach((z) => map.removeLayer(z.layer));
  numberLayers.forEach((l) => map.removeLayer(l));
  zones = []; numberLayers = [];
  addZonesFromGeoJSON({ features: doc.zones.map((z) => z.feature) });
  $('plan').click();
}
