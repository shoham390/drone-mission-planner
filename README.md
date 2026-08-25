# Drone Mission Planner

Static web app: upload KML/KMZ → polygons on a map → nearest-neighbor scan order →
per-zone Google Maps + Waze links. Google login + saves files/missions to your Drive.

## One-time Google setup (needed for login + Drive)

1. https://console.cloud.google.com → new project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **OAuth consent screen:** External, add yourself as a test user.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Add **Authorized JavaScript origins**:
   - `http://localhost:8080` (local test)
   - `https://<your-user>.github.io` (after deploy)
5. Copy the client ID into `CLIENT_ID` at the top of `app.js`.

Scope is `drive.file` — the app only sees files it creates, so Google does **not**
require app verification.

## Run locally

```
python3 -m http.server 8000
```

- Desktop preview: http://localhost:8000
- iPhone preview: http://localhost:8000/.claude/iphone.html

`.claude/iphone.html` wraps `index.html` in a 390×844 iframe with a phone bezel, for
checking mobile layout without DevTools emulation. It lives in `.claude/` because that
dir is gitignored — it's a local dev aid, not part of the app.

Whichever port you use, it must be listed as an **Authorized JavaScript origin** on the
OAuth client (see setup above) or Google login fails.

## Deploy (GitHub Pages)

Push these files to a repo → **Settings → Pages →** deploy from branch root.
URL is `https://<your-user>.github.io/<repo>/`.

## Headless mission publishing (`scripts/`)

The nightly agent that scrapes the flight portal cannot sign the app in: GIS tokens live
in `sessionStorage`, last ~1h and need a user gesture, so an unattended run always lands
on the sign-in gate. Instead the agent never touches the app — it writes the mission file
straight into the app's Drive folder through a local uploader:

```
agent → <date>.mission.json drop → launchd → drive_writer.py → Drive → app
```

- `kml2mission.py` — KML/KMZ + flight text → the `<date>.mission.json` the app loads.
  Pure offline computation. Mirrors `addZonesFromGeoJSON` (naming, ring de-dup, duplicate
  numbering) and `orderByNearestNeighbor`, so a mission built here is identical to one
  built by dragging the same files into the app. `--selftest` covers all of that.
- `drive_writer.py` — uploads drops with a stored refresh token, no browser.
  `--upload-pending` (what launchd runs), `--check` (is the token alive?), `--login`,
  `--selftest`.
- `install-uploader.command` — double-click once: installs the `com.shoham.dmp-uploader`
  LaunchAgent, which watches `scripts/pending/` and also sweeps recent Cowork session
  outputs dirs every 5 minutes (the agent's session path changes every run, so WatchPaths
  alone can't see it).

Two things to know:

1. **The desktop OAuth client must be in the same Cloud project as the app.** Drive grants
   `drive.file` visibility per project, so a file created by the desktop client is visible
   to the web app's client. A different project would upload fine and the app would never
   see it.
2. **The consent screen is in Testing, so refresh tokens expire every 7 days.** When they
   do, the uploader logs `TOKEN DEAD` and the fix is `uv run scripts/drive_writer.py
   --login`. To stop the weekly re-login, publish the consent screen to *In production*;
   that needs the writer on the non-sensitive `drive.file` scope rather than full `drive`,
   otherwise Google requires app verification.

`scripts/uploader.log` is the audit trail — the nightly task reads it to confirm the
mission landed.

## Test

```
node geo.test.mjs                       # centroid / route ordering / link building
node verts.test.mjs
python3 scripts/kml2mission.py --selftest
uv run scripts/drive_writer.py --selftest
```
