# /// script
# requires-python = ">=3.10"
# dependencies = ["google-auth", "google-auth-oauthlib", "requests"]
# ///
"""
Headless writer for Drone Mission Planner missions.

Writes mission files into your Drive's "Drone Mission Planner" folder — the same
folder the web app reads — with NO browser and NO popup.

Why this exists: the web app authenticates with Google Identity Services, whose
tokens live in sessionStorage, last ~1h and need a user gesture to re-mint. An
unattended nightly job can never sign it in. So the nightly job never touches the
app's UI: it just drops a finished mission JSON into `pending/`, and this script
(triggered by launchd WatchPaths, see install-uploader.command) uploads it.

    agent → scripts/pending/2026-08-07.mission.json → launchd → this → Drive → app

A drop may also be a *.manifest.json — the raw scrape ({date, records:[{title, kml,
flight}]}) straight off the portal. This script converts it with kml2mission.build()
before uploading. That lets the nightly agent, which runs in a Cowork session with no
checkout of this repo, skip reimplementing app.js's zone naming/de-dup/ordering rules:
it dumps what it scraped, and the canonical converter here turns it into the mission.

Setup (once):
  1. Google Cloud Console → SAME project as the app → Credentials →
     Create Credentials → OAuth client ID → type "Desktop app".
     Download the JSON, save it next to this file as `client_secret.json`.
     Same project matters: Drive's drive.file visibility is granted per Cloud
     project, so files this client creates are visible to the web app's client.
  2. uv run scripts/drive_writer.py --login     (one browser consent)
  3. ./scripts/install-uploader.command         (installs the launchd watcher)

Commands:
  --login            mint token.json (interactive, once)
  --pull-daily       read today's KML/KMZ drop from Drive ("Agent Misson Planer Kml"/
                     <date>), convert, and upload <date>.mission.json for the app
  --upload-pending   upload every pending/*.mission.json and *.manifest.json,
                     then move it to done/
  --check            refresh the token and list the Drive folder; exits non-zero
                     if the token is dead (use this to detect a needed re-login)
  --selftest         offline sanity check, no network

Both `client_secret.json` and `token.json` are secrets — gitignored, never commit.
"""
import base64
import datetime as dt
import json
import pathlib
import re
import shutil
import sys

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # kml2mission sits next to this file; stdlib-only, no deps
import kml2mission  # noqa: E402
CLIENT_SECRET = HERE / "client_secret.json"
TOKEN = HERE / "token.json"
PENDING = HERE / "pending"
DONE = HERE / "done"
LOG = HERE / "uploader.log"
# Second pickup path. The nightly agent runs in a fresh Cowork session that does NOT have
# this repo mounted, but it can always write to its own session outputs dir — so we also
# sweep there for *.mission.json drops and mark them .uploaded when done.
SESSION_ROOT = (pathlib.Path.home() / "Library/Application Support/Claude"
                / "local-agent-mode-sessions")
SWEEP_MAX_AGE_H = 24
# Full drive scope: this is your own headless writer, and it sidesteps whether the
# app's narrower drive.file visibility carries across OAuth clients.
SCOPES = ["https://www.googleapis.com/auth/drive"]
FOLDER_NAME = "Drone Mission Planner"  # must match FOLDER_NAME in app.js
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3"


def log(msg):
    line = f"{dt.datetime.now().isoformat(timespec='seconds')}  {msg}"
    print(line)
    with LOG.open("a") as fh:  # the agent reads this file to confirm the upload landed
        fh.write(line + "\n")


def creds():
    """Load saved creds, refreshing the ~1h access token from the refresh token as needed."""
    if not TOKEN.exists():
        sys.exit("No token.json — run `--login` once first.")
    c = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if not c.valid:
        c.refresh(Request())  # trades the durable refresh token for a fresh access token
        TOKEN.write_text(c.to_json())  # persist a rotated refresh token if Google sent one
    return c


def login():
    if not CLIENT_SECRET.exists():
        sys.exit(f"Missing {CLIENT_SECRET.name} — download the Desktop OAuth client JSON here.")
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
    c = flow.run_local_server(port=0)  # opens your browser once, captures the consent
    TOKEN.write_text(c.to_json())
    print(f"Saved {TOKEN.name}. The watcher can now upload with no popup.")


def _get(token, url):
    r = requests.get(url, headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    return r.json()


def folder_id(token):
    q = f"name='{FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    files = _get(token, f"{API}/files?q={requests.utils.quote(q)}&fields=files(id)").get("files", [])
    if files:
        return files[0]["id"]
    r = requests.post(f"{API}/files",
                      headers={"Authorization": f"Bearer {token}"},
                      json={"name": FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"})
    r.raise_for_status()
    return r.json()["id"]


def find_in_folder(token, name, parent):
    q = f"name='{name}' and '{parent}' in parents and trashed=false"
    files = _get(token, f"{API}/files?q={requests.utils.quote(q)}&fields=files(id)").get("files", [])
    return files[0]["id"] if files else None


def multipart(name, mime, base64_body, parent=None):
    """Same multipart/related body app.js builds (app.js:626). parent set only on create."""
    b = "b" + str(int(dt.datetime.now().timestamp()))
    meta = {"name": name, "mimeType": mime}
    if parent:
        meta["parents"] = [parent]  # parents may only be set at creation
    body = (
        f"--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
        + json.dumps(meta)
        + f"\r\n--{b}\r\nContent-Type: {mime}\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        + base64_body + f"\r\n--{b}--"
    )
    return b, body


def upsert(token, name, mime, base64_body):
    """Create the file, or update it in place if that name already exists — so re-running
    the nightly job for the same date replaces the mission instead of duplicating it."""
    parent = folder_id(token)
    fid = find_in_folder(token, name, parent)
    b, body = multipart(name, mime, base64_body, parent=None if fid else parent)
    url = f"{UPLOAD}/files/{fid}?uploadType=multipart" if fid else f"{UPLOAD}/files?uploadType=multipart"
    r = requests.request("PATCH" if fid else "POST", url,
                         headers={"Authorization": f"Bearer {token}",
                                  "Content-Type": f"multipart/related; boundary={b}"},
                         data=body.encode("utf-8"))
    r.raise_for_status()
    return r.json(), bool(fid)


def validate(doc, name):
    """Fail loudly on a malformed drop rather than uploading a mission the app can't open."""
    if set(doc) < {"name", "zones"}:
        raise ValueError("mission must have 'name' and 'zones'")
    if doc["name"] != name:
        raise ValueError(f"doc['name'] is {doc['name']!r} but the file is {name!r} — the app "
                         "uses the filename, keep them identical")
    if not doc["zones"]:
        raise ValueError("no zones")
    for i, z in enumerate(doc["zones"]):
        if not z.get("name"):
            raise ValueError(f"zone {i} has no name")
        g = (z.get("feature") or {}).get("geometry") or {}
        if g.get("type") != "Polygon" or not g.get("coordinates"):
            raise ValueError(f"zone {z.get('name')} is not a Polygon feature")
        ring = g["coordinates"][0]
        if len(ring) < 4:
            raise ValueError(f"zone {z['name']} ring has {len(ring)} points")
        if any(not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90) for p in ring):
            raise ValueError(f"zone {z['name']} has out-of-range coords — lng,lat order?")


DROP_GLOBS = ("*.mission.json", "*.manifest.json")


def sweep_session_outputs():
    """Mission or manifest drops the agent left in a recent Cowork session outputs dir."""
    if not SESSION_ROOT.is_dir():
        return []
    cutoff = dt.datetime.now().timestamp() - SWEEP_MAX_AGE_H * 3600
    found = []
    for pat in DROP_GLOBS:
        for p in SESSION_ROOT.glob(f"*/*/*/outputs/{pat}"):
            try:
                if p.stat().st_mtime >= cutoff:
                    found.append(p)
            except OSError:
                pass
    return sorted(found)


def load_drop(p):
    """(target filename, mission doc, stats) for a drop, converting a manifest if needed.

    A manifest's target name comes from its own "date" field, not the file name, so a
    manifest and the mission it produces can never disagree about which day it is.
    """
    data = json.loads(p.read_text())
    if p.name.endswith(".manifest.json"):
        doc, stats = kml2mission.build(data)
        return doc["name"], doc, stats
    return p.name, data, None


def upload_pending():
    """Upload every mission drop found in pending/ or a recent session outputs dir.

    pending/ drops are moved to done/; session drops are renamed .uploaded in place —
    either way a drop is consumed exactly once, so the 5-minute timer can re-run freely.
    """
    PENDING.mkdir(exist_ok=True)
    DONE.mkdir(exist_ok=True)
    local = sorted(q for pat in DROP_GLOBS for q in PENDING.glob(pat))
    drops = local + sweep_session_outputs()
    if not drops:
        return
    token = creds().token
    for p in drops:
        try:
            if not p.exists():  # raced the launchd watcher — its upload counts
                continue
            target, doc, stats = load_drop(p)
            validate(doc, target)
            body = base64.b64encode(json.dumps(doc, ensure_ascii=False).encode("utf-8")).decode("ascii")
            f, updated = upsert(token, target, "application/json", body)
            if p.parent == PENDING:
                shutil.move(str(p), str(DONE / p.name))
            else:
                p.rename(p.with_name(p.name + ".uploaded"))
            extra = f" from {p.name}" if target != p.name else ""
            if stats:
                extra += (f" [{stats['withFlight']}/{stats['zones']} with flight"
                          f", {stats['duplicateRingsSkipped']} dupe rings skipped]")
            log(f"OK {'updated' if updated else 'created'} {target} "
                f"({len(doc['zones'])} zones){extra} → file id {f['id']}")
        except FileNotFoundError:  # consumed mid-flight by the other uploader
            continue
        except Exception as e:  # one bad drop must not block the others
            p.rename(p.with_name(p.name + ".failed"))
            log(f"FAIL {p.name}: {type(e).__name__}: {e}")


SOURCE_FOLDER = "Agent Misson Planer Kml"  # the skill's drop area (inside "Propellor KML")


def pull_daily():
    """Read today's AND tomorrow's KMLs from the skill's Drive drop, convert, upload.

    Both days because the skill creates tomorrow's folder the evening before — the
    app's "Tomorrow" auto-load needs that mission published the same evening.

    The skill writes raw KML/KMZ into SOURCE_FOLDER/<date>/ with a different OAuth
    client, so the web app's drive.file scope can never see them. This token has full
    drive scope, so we bridge: read there, publish <date>.mission.json into the app's
    own folder via the normal pending/ → upload_pending() path.
    """
    token = creds().token
    q = f"name='{SOURCE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    src = _get(token, f"{API}/files?q={requests.utils.quote(q)}&fields=files(id)").get("files", [])
    if not src:
        sys.exit(f"Drive folder {SOURCE_FOLDER!r} not found")

    def fetch(fid):
        r = requests.get(f"{API}/files/{fid}?alt=media",
                         headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        return r.content

    pulled = 0
    for day in (dt.date.today(), dt.date.today() + dt.timedelta(days=1)):
        day = day.isoformat()
        # the skill can leave several folders named <day> (re-runs) — newest wins
        q = (f"name='{day}' and '{src[0]['id']}' in parents and "
             "mimeType='application/vnd.google-apps.folder' and trashed=false")
        folders = _get(token, f"{API}/files?q={requests.utils.quote(q)}"
                              "&fields=files(id,createdTime)").get("files", [])
        if not folders:
            log(f"no '{day}' folder in {SOURCE_FOLDER!r} — skipped")
            continue
        newest = max(folders, key=lambda f: f["createdTime"])
        q = f"'{newest['id']}' in parents and trashed=false"
        files = _get(token, f"{API}/files?q={requests.utils.quote(q)}&fields=files(id,name)").get("files", [])
        # optional flight-settings sidecar: a "<kml stem>.txt" next to its kml
        texts = {re.sub(r"\.txt$", "", f["name"], flags=re.I): fetch(f["id"]).decode("utf-8", "replace")
                 for f in files if f["name"].lower().endswith(".txt")}
        records = [{"title": f["name"],
                    "kml": kml2mission.kml_text(fetch(f["id"])),
                    "flight": texts.get(re.sub(r"\.km[lz]$", "", f["name"], flags=re.I), "")}
                   for f in sorted(files, key=lambda f: f["name"])
                   if re.search(r"\.km[lz]$", f["name"], re.I)]
        if not records:
            log(f"'{day}' folder has no .kml/.kmz files — skipped")
            continue
        doc, stats = kml2mission.build({"date": day, "records": records})
        PENDING.mkdir(exist_ok=True)
        (PENDING / doc["name"]).write_text(json.dumps(doc, ensure_ascii=False))
        log(f"pulled {len(records)} kml from '{day}' ({len(folders)} folder(s), newest won) "
            f"→ {doc['name']} {stats}")
        pulled += 1
    if not pulled:
        sys.exit("nothing to pull for today or tomorrow")
    upload_pending()


def check():
    """Prove the token still works. The OAuth consent screen being in 'Testing' expires
    refresh tokens after 7 days, so a dead token here means: re-run --login."""
    try:
        token = creds().token
    except Exception as e:
        log(f"TOKEN DEAD: {e} — re-run: uv run scripts/drive_writer.py --login")
        sys.exit(1)
    fid = folder_id(token)
    q = f"'{fid}' in parents and trashed=false"
    files = _get(token, f"{API}/files?q={requests.utils.quote(q)}"
                        "&fields=files(name,modifiedTime)&orderBy=modifiedTime desc"
                        "&pageSize=20").get("files", [])
    log(f"token ok; folder {fid}; {len(files)} recent files")
    for f in files[:20]:
        print(f"  {f['modifiedTime']}  {f['name']}")


def selftest():
    """Smallest check on the non-trivial bits: multipart framing and drop validation."""
    body = base64.b64encode(json.dumps({"zones": []}).encode()).decode("ascii")
    b, mp = multipart("x.mission.json", "application/json", body, parent="PARENT")
    assert mp.startswith(f"--{b}\r\n") and mp.endswith(f"--{b}--"), "boundary framing broken"
    assert '"parents": ["PARENT"]' in mp, "parent must be set on create"
    assert body in mp, "payload must ride in the second part"
    _, mp2 = multipart("x", "application/json", body, parent=None)
    assert "parents" not in mp2, "update must NOT resend parents"

    ring = [[35.0, 32.0], [35.1, 32.0], [35.1, 32.1], [35.0, 32.0]]
    good = {"name": "d.mission.json", "zones": [{"order": 1, "name": "A", "flight": "",
            "feature": {"type": "Feature", "properties": {"name": "A"},
                        "geometry": {"type": "Polygon", "coordinates": [ring]}}}]}
    validate(good, "d.mission.json")
    for bad, why in [
        ({**good, "zones": []}, "empty zones"),
        ({**good, "name": "other.mission.json"}, "name mismatch"),
        # note: a lat/lng swap inside Israel (32.x ↔ 35.x) is NOT catchable here — both
        # values stay in range. The converter guards that by parsing KML's lng,lat order.
        ({**good, "zones": [{**good["zones"][0], "feature": {"type": "Feature", "properties": {},
          "geometry": {"type": "Polygon", "coordinates": [[[32.0, 135.0]] * 4]}}}]}, "out-of-range coords"),
    ]:
        try:
            validate(bad, "d.mission.json")
            raise AssertionError(f"validate should have rejected: {why}")
        except ValueError:
            pass

    # A manifest drop must convert to a mission the uploader would accept, and must take
    # its date from the manifest body — this is the path the nightly agent actually uses.
    import tempfile
    coords = " ".join(f"{x},{y},0" for x, y in ring)
    kml = ('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2">'
           "<Document><Placemark><name>שדה</name><Polygon><outerBoundaryIs><LinearRing>"
           f"<coordinates>{coords}</coordinates>"
           "</LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>")
    with tempfile.TemporaryDirectory() as td:
        m = pathlib.Path(td) / "whatever-the-file-is-called.manifest.json"
        m.write_text(json.dumps({"date": "2026-08-25",
                                 "records": [{"title": "שדה", "kml": kml, "flight": "גובה: 80"}]},
                                ensure_ascii=False))
        target, doc, stats = load_drop(m)
        assert target == "2026-08-25.mission.json", f"date must come from the body, got {target}"
        validate(doc, target)  # must satisfy the same gate as a hand-built mission
        assert doc["zones"][0]["flight"] == "גובה: 80", "flight text must survive conversion"
        assert stats["withFlight"] == 1, stats
    print("selftest ok")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    {"--login": login, "--pull-daily": pull_daily, "--upload-pending": upload_pending,
     "--check": check, "--selftest": selftest}.get(arg, lambda: sys.exit(
        "usage: drive_writer.py --login | --pull-daily | --upload-pending | --check | --selftest"))()
