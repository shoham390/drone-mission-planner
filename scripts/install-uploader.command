#!/bin/bash
# One-time setup for the headless mission uploader. Double-click this file in Finder.
#
# Installs a LaunchAgent that watches scripts/pending/ and runs
# `drive_writer.py --upload-pending` whenever a file appears there. That's what lets the
# nightly agent publish a mission to Drive without ever signing the web app in to Google.
#
# Safe to re-run: it reinstalls the agent and re-verifies the token.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
LABEL="com.shoham.dmp-uploader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Repo: $REPO"

UV="$(command -v uv || true)"
[ -x "/opt/homebrew/bin/uv" ] && UV="${UV:-/opt/homebrew/bin/uv}"
[ -x "$HOME/.local/bin/uv" ] && UV="${UV:-$HOME/.local/bin/uv}"
if [ -z "$UV" ]; then
  echo "ERROR: uv not found. Install it with:  curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo "then double-click this file again."
  read -r -p "Press return to close." _ ; exit 1
fi
echo "uv:   $UV"

mkdir -p "$REPO/scripts/pending" "$REPO/scripts/done" "$HOME/Library/LaunchAgents"

# Token check first — an expired refresh token is the one failure that needs YOU, and
# it's better to learn it now than at 10 PM. This opens a browser only if needed.
if ! "$UV" run "$REPO/scripts/drive_writer.py" --check; then
  echo
  echo "Token is not usable. Running --login once (a browser window will open)…"
  "$UV" run "$REPO/scripts/drive_writer.py" --login
  "$UV" run "$REPO/scripts/drive_writer.py" --check
fi

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$UV</string>
    <string>run</string>
    <string>$REPO/scripts/drive_writer.py</string>
    <string>--upload-pending</string>
  </array>
  <key>WatchPaths</key>
  <array><string>$REPO/scripts/pending</string></array>
  <!-- The nightly agent usually drops its mission in a Cowork session outputs dir, which
       WatchPaths can't cover (the path has a fresh session id each run), so also poll. -->
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REPO/scripts/uploader.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/scripts/uploader.err.log</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
echo "Installed $LABEL"
echo
echo "Watching: $REPO/scripts/pending"
echo "Log:      $REPO/scripts/uploader.log"
echo
echo "Done. You can close this window."
read -r -p "Press return to close." _
