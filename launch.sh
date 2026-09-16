#!/bin/bash
# Starts the tracker if it is not running. With --no-open it does not open a browser (the app window does that).
DIR="/Users/miriamweiss/Desktop/appointment tracker"
NODE="/opt/homebrew/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || echo /usr/local/bin/node)"
PORT="$(grep -E '^PORT=' "$DIR/.env" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-3123}"
URL="http://localhost:$PORT"
alive() { curl -s --max-time 2 "$URL/api/state" >/dev/null 2>&1; }

if ! alive; then
  cd "$DIR" || { osascript -e 'display alert "מעקב פגישות" message "תיקיית הפרויקט לא נמצאה בשולחן העבודה."'; exit 1; }
  mkdir -p data
  # a half-dead previous copy (or its hidden Chrome) would block the new one
  pkill -f "node src/index.js" 2>/dev/null; pkill -f "whatsapp-session" 2>/dev/null; sleep 1
  [ -f data/tracker.log ] && [ "$(stat -f%z data/tracker.log)" -gt 5000000 ] && : > data/tracker.log
  nohup "$NODE" src/index.js >> data/tracker.log 2>&1 &
  for i in $(seq 1 60); do sleep 0.5; alive && break; done
  if ! alive; then
    osascript -e 'display alert "מעקב פגישות" message "התוכנה לא עלתה. לפתוח טרמינל בתיקיית הפרויקט ולהריץ: npm start   כדי לראות את השגיאה."'
    exit 1
  fi
fi
[ "$1" = "--no-open" ] || open "$URL"
