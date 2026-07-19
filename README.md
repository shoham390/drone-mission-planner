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

## Test

```
node geo.test.mjs   # centroid / route ordering / link building
```
