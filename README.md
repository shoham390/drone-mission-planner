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
python3 -m http.server 8080   # then open http://localhost:8080
```

## Deploy (GitHub Pages)

Push these files to a repo → **Settings → Pages →** deploy from branch root.
URL is `https://<your-user>.github.io/<repo>/`.

## Test

```
node geo.test.mjs   # centroid / route ordering / link building
```
