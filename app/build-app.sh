#!/bin/bash
# Rebuilds the "מעקב פגישות" app on the Desktop from app/main.swift (needs Xcode Command Line Tools).
set -e
cd "$(dirname "$0")"
APP="$HOME/Desktop/מעקב פגישות.app"
swiftc -O -o "מעקב פגישות" main.swift -framework Cocoa -framework WebKit
pkill -x "מעקב פגישות" 2>/dev/null || true
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "מעקב פגישות" "$APP/Contents/MacOS/"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp Info.plist "$APP/Contents/Info.plist"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep -s - "$APP"
echo "built: $APP"
