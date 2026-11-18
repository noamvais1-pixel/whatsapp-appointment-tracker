#!/bin/bash
# Rebuilds the "מעקב פגישות" app on the Desktop from app/main.swift (needs Xcode Command Line Tools).
# A second copy of the project (second phone) builds its own app:  bash app/build-app.sh "מעקב פגישות 2"
set -e
cd "$(dirname "$0")"
NAME="${1:-מעקב פגישות}"
PROJECT="$(cd .. && pwd)"
APP="$HOME/Desktop/$NAME.app"
swiftc -O -target "$(uname -m)-apple-macos12.0" -o "$NAME" main.swift -framework Cocoa -framework WebKit
pkill -x "$NAME" 2>/dev/null || true
# Update the existing app in place: deleting and recreating it makes macOS list one more
# "מעקב פגישות" in the Apps view on every rebuild.
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv -f "$NAME" "$APP/Contents/MacOS/"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp Info.plist "$APP/Contents/Info.plist"
if [ "$NAME" != "מעקב פגישות" ]; then
  P="$APP/Contents/Info.plist"
  for k in CFBundleName CFBundleDisplayName CFBundleExecutable; do plutil -replace "$k" -string "$NAME" "$P"; done
  plutil -replace CFBundleIdentifier -string "local.miriamweiss.appointment-tracker.$(echo "$NAME" | md5 | cut -c1-8)" "$P"
fi
plutil -replace ProjectDir -string "$PROJECT" "$APP/Contents/Info.plist"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep -s - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "built: $APP"
