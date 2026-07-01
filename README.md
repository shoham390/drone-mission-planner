# Drone Mission Planner

Static web app: upload KML/KMZ → polygons on a map → nearest-neighbor scan order →
per-zone Google Maps + Waze links. Google login + saves files/missions to your Drive.

## One-time Google setup (needed for login + Drive)

1. https://console.cloud.google.com → new project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **OAuth consent screen:** External, add yourself as a test user.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Add **Authorized JavaScript origins**:
   - `http://localhost:8000` (local test)
   - `https://<your-user>.github.io` (after deploy)
5. Copy the client ID into `CLIENT_ID` at the top of `app.js`.

Scope is `drive.file` — the app only sees files it creates, so Google does **not**
require app verification.

## Run locally

```
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploy (GitHub Pages)

Push these files to a repo → **Settings → Pages →** deploy from branch root.
URL is `https://<your-user>.github.io/<repo>/`.

## Test

```
node geo.test.mjs   # centroid / route ordering / link building
```

## Airspace overlay (`airspace.geojson`)

Toggleable reference layer — one switch each for CTR / prohibited (LLP) /
restricted (LLR) / border. Provenance, strongest first:

- **LLP + LLR** — Israel's **official eAIP ENR 5.1** (exact DMS coordinates;
  circle/arc boundary clauses computed geodetically). This is the legal
  source the sporting chart itself is drawn from. Verified by georeferencing
  the chart PDFs and overlaying the parsed polygons — they land on the drawn
  boundaries.
- **CTR** — OpenAIP (community aggregation; CTRs aren't in the ENR sections).
- **Border** — a standard state boundary, reference line only.

**Not included, by design:** danger areas (LLD) — Israel's civil AIP lists
**none** (ENR 5.1/5.2/5.5 are NIL for them); the LLD zones on the sporting
chart are a separate, non-public publication. The near-border no-fly buffer
has **no fixed distance** — it's set by NOTAM per the security situation.
**Planning aid, not for clearance.**

### Updating after Israel publishes a new AIRAC cycle

The eAIP is at <https://e-aip.azurefd.net/> with AIRAC-dated URLs.

```
python3 tools/build_airspace.py 2026-08-06   # <- current effective date
```

No dependencies. It refetches ENR 5.1 + OpenAIP + the border, rebuilds
`airspace.geojson`, and prints a self-check (counts; the out-of-bounds list
should show only LLR01/LLR02, which really do extend over the sea). Review,
then commit. Omit the date to rebuild the pinned cycle (2025-10-02).
