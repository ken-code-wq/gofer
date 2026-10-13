#!/usr/bin/env bash
# Installs "Voice Browser.app" into /Applications (or the folder given as $1).
# The app contains the desktop bar; the server, .env and browser profile stay in this project folder.
# Re-run after moving the project folder or changing files in desktop/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="${1:-/Applications}"
APP="$DEST/Voice Browser.app"
SRC="$HERE/node_modules/electron/dist/Electron.app"
BUNDLE_ID="local.voice-browser"
[ -d "$SRC" ] || { echo "Electron missing: run npm install in $HERE first" >&2; exit 1; }

if [ -d "$APP" ]; then
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  case "$existing" in
    "$BUNDLE_ID"|local.voice-browser.launcher) rm -rf "$APP" ;;
    *) echo "$APP exists and isn't ours ($existing); not touching it" >&2; exit 1 ;;
  esac
fi
pkill -f "Voice Browser.app/Contents/MacOS" 2>/dev/null || true

ditto "$SRC" "$APP"
RES="$APP/Contents/Resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app"
cp "$HERE"/*.cjs "$HERE/bar.html" "$HERE/package.json" "$RES/app/"
cp "$HERE"/build/trayTemplate*.png "$RES/app/"
printf '{ "root": "%s" }\n' "$ROOT" > "$RES/app/root.json"
cp "$HERE/build/icon.icns" "$RES/electron.icns"

PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Voice Browser" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Voice Browser" "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Voice Browser" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PL"
# Quitting a browser (to reopen it with remote control) is done like ⌘Q, via Apple Events.
/usr/libexec/PlistBuddy -c "Set :NSAppleEventsUsageDescription Voice Browser quits and reopens your browser so it can control it." "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string Voice Browser quits and reopens your browser so it can control it." "$PL"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1
touch "$APP" # refresh Finder / Dock icon cache
rm -rf "$HOME/Applications/Voice Browser.app" # old launcher from make-app.sh
echo "Installed $APP (project: $ROOT)"
