#!/usr/bin/env bash
# Installs "Gofer.app" into /Applications (or the folder given as $1).
# The app contains the desktop bar; the server, .env and browser profile stay in this project folder.
# Re-run after moving the project folder or changing files in desktop/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="${1:-/Applications}"
APP="$DEST/Gofer.app"
OLD_APP="$DEST/Voice Browser.app" # the app's name before it became Gofer
SRC="$HERE/node_modules/electron/dist/Electron.app"
BUNDLE_ID="local.gofer"
[ -d "$SRC" ] || { echo "Electron missing: run npm install in $HERE first" >&2; exit 1; }

bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true; }
if [ -d "$APP" ]; then
  existing="$(bundle_id "$APP")"
  case "$existing" in
    "$BUNDLE_ID") rm -rf "$APP" ;;
    *) echo "$APP exists and isn't ours ($existing); not touching it" >&2; exit 1 ;;
  esac
fi
pkill -f "Gofer.app/Contents/MacOS" 2>/dev/null || true
# Voice Browser is now Gofer: quit and remove the old app (its data moves over on first launch).
if [ -d "$OLD_APP" ]; then
  case "$(bundle_id "$OLD_APP")" in
    local.voice-browser|local.voice-browser.launcher)
      pkill -f "Voice Browser.app/Contents/MacOS" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "Voice Browser.app/Contents/MacOS" >/dev/null || break; sleep 0.5; done
      rm -rf "$OLD_APP" ;;
  esac
fi

ditto "$SRC" "$APP"
RES="$APP/Contents/Resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app"
cp "$HERE"/*.cjs "$HERE/bar.html" "$HERE/package.json" "$RES/app/"
cp "$HERE"/build/trayTemplate*.png "$RES/app/"
# Liquid Glass (macOS 26+): the addon and its loader
mkdir -p "$RES/app/node_modules"
for m in electron-liquid-glass node-gyp-build; do [ -d "$HERE/node_modules/$m" ] && cp -R "$HERE/node_modules/$m" "$RES/app/node_modules/"; done
printf '{ "root": "%s" }\n' "$ROOT" > "$RES/app/root.json"
cp "$HERE/build/icon.icns" "$RES/electron.icns"

PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Gofer" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Gofer" "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Gofer" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PL"
# Quitting a browser (to reopen it with remote control) is done like ⌘Q, via Apple Events.
/usr/libexec/PlistBuddy -c "Set :NSAppleEventsUsageDescription Gofer quits and reopens your browser so it can control it." "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string Gofer quits and reopens your browser so it can control it." "$PL"

# The chat panel records voice requests.
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription Gofer listens when you hold Option or click the mic, to turn your voice into a request." "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string Gofer listens when you hold Option or click the mic, to turn your voice into a request." "$PL"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1
touch "$APP" # refresh Finder / Dock icon cache
rm -rf "$HOME/Applications/Voice Browser.app" # old launcher from make-app.sh
echo "Installed $APP (project: $ROOT)"
