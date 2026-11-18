#!/bin/bash
# Starts the tracker if it is not running. With --no-open it does not open a browser (the app window does that).
# Works from any copy of the project folder (a second copy links a second phone), and only ever
# stops this folder's own tracker and hidden Chrome, never another copy's.
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/opt/homebrew/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || echo /usr/local/bin/node)"
PORT="$(grep -E '^PORT=' "$DIR/.env" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-3123}"
URL="http://localhost:$PORT"
alive() { curl -s --max-time 2 "$URL/api/state" >/dev/null 2>&1; }

# this folder's tracker: started with the full path, or (older starts) as "node src/index.js" from inside it
stop_own_tracker() {
  pkill -f "$DIR/src/index.js" 2>/dev/null
  for pid in $(pgrep -f "node src/index.js"); do
    [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$DIR" ] && kill "$pid" 2>/dev/null
  done
}

if ! alive; then
  cd "$DIR" || { osascript -e 'display alert "מעקב פגישות" message "תיקיית הפרויקט לא נמצאה בשולחן העבודה."'; exit 1; }
  mkdir -p data
  # a half-dead previous copy (or its hidden Chrome) would block the new one
  stop_own_tracker; pkill -f "$DIR/data/whatsapp-session" 2>/dev/null; sleep 1
  [ -f data/tracker.log ] && [ "$(stat -f%z data/tracker.log)" -gt 5000000 ] && : > data/tracker.log
  nohup "$NODE" "$DIR/src/index.js" >> data/tracker.log 2>&1 &
  for i in $(seq 1 60); do sleep 0.5; alive && break; done
  if ! alive; then
    osascript -e 'display alert "מעקב פגישות" message "התוכנה לא עלתה. לפתוח טרמינל בתיקיית הפרויקט ולהריץ: npm start   כדי לראות את השגיאה."'
    exit 1
  fi
fi
[ "$1" = "--no-open" ] || open "$URL"
