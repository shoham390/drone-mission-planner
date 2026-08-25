# Drone Mission Planner — working rules

Static web app. No build step, no package manager. `index.html` + `app.js` + `geo.js`.

## Editing

Just make the change. For anything non-obvious or risky, say what you're doing in a line
or two, but don't block on approval.

## Git

**Only push when asked.** Never `git push` (or commit) on your own initiative — but when I
say to push, push. Don't block it.

## Running it

```
python3 -m http.server 8000
```

Open both in the user's real Chrome (`open -a "Google Chrome" <url>`), not only the
built-in browser pane:

- Desktop → http://localhost:8000
- iPhone  → http://localhost:8000/.claude/iphone.html

**End every answer with both links.**

If port 8000 is already held by another session serving this same dir, reuse it rather
than fighting for the port.

## Local dev aids (gitignored, not part of the app)

- `.claude/launch.json` — dev server config, name `drone-mission-planner`.
- `.claude/iphone.html` — 390×844 iframe of `index.html` with a phone bezel, for checking
  mobile layout without DevTools emulation.

## Gotcha: OAuth origin must match the port

`CLIENT_ID` in `app.js` only accepts origins registered in Google Cloud Console. The
README's setup step lists `http://localhost:8080`; running on 8000 without adding it as a
second authorized origin makes "Sign in with Google" fail.

## Gotcha: mission JSON has two producers

`scripts/kml2mission.py` builds the same mission file the app's Save button builds. If you
change the zone shape, the naming rules in `addZonesFromGeoJSON`, or `featureName`, change
the Python mirror too — otherwise the nightly headless publish silently drifts from what
the UI produces. Zone `name` must equal `feature.properties.name`; flight settings are
re-paired by name on load (app.js:788).

## Test

```
node geo.test.mjs
node verts.test.mjs
python3 scripts/kml2mission.py --selftest
uv run scripts/drive_writer.py --selftest
```
