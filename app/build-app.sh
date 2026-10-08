#!/bin/bash
# Rebuilds the "מעקב פגישות" app on the Desktop from app/main.swift (needs Xcode Command Line Tools).
set -e
cd "$(dirname "$0")"
APP="$HOME/Desktop/מעקב פגישות.app"
swiftc -O -target "$(uname -m)-apple-macos12.0" -o "מעקב פגישות" main.swift -framework Cocoa -framework WebKit
pkill -x "מעקב פגישות" 2>/dev/null || true
# Update the existing app in place: deleting and recreating it makes macOS list one more
# "מעקב פגישות" in the Apps view on every rebuild.
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv -f "מעקב פגישות" "$APP/Contents/MacOS/"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp Info.plist "$APP/Contents/Info.plist"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep -s - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "built: $APP"
