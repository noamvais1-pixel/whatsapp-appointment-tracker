#!/bin/bash
# Double-click to make the tracker start automatically when you log in to this Mac.
# Double-click again to turn it off.
PLIST="$HOME/Library/LaunchAgents/local.miriamweiss.appointment-tracker.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/opt/homebrew/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "Start at login is now OFF. (The tracker keeps running until you quit it from the dashboard.)"
else
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.miriamweiss.appointment-tracker</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>src/index.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$DIR/data/tracker.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/tracker.log</string>
</dict></plist>
PL
  if curl -s --max-time 2 http://localhost:3123/api/state >/dev/null 2>&1; then
    echo "Start at login is now ON. It will take over the next time you log in (the tracker is already running now)."
  else
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && echo "Start at login is now ON, and the tracker has been started."
  fi
fi
echo; echo "You can close this window."
