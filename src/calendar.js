/**
 * Mirrors meetings and calls (items with a date) into the Mac Calendar app, into one dedicated
 * calendar. If that calendar lives in an iCloud account it shows up on the iPhone by itself.
 *
 * Talks to Calendar.app through AppleScript (osascript). Our own table remembers which event
 * belongs to which item, so updates and cancellations edit the same event instead of duplicating it.
 */
import { execFile } from "node:child_process";
import { config } from "./config.js";
import * as store from "./db.js";

const run = (script, args = []) =>
  new Promise((resolve, reject) =>
    execFile("osascript", ["-e", script, "--", ...args], { timeout: 60000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split("\n")[0])) : resolve(stdout.trim()),
    ),
  );

store.db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
  item_id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const q = {
  get: store.db.prepare("SELECT * FROM calendar_events WHERE item_id = ?"),
  put: store.db.prepare("INSERT OR REPLACE INTO calendar_events (item_id, uid, signature, updated_at) VALUES (?, ?, ?, datetime('now'))"),
  del: store.db.prepare("DELETE FROM calendar_events WHERE item_id = ?"),
  all: store.db.prepare("SELECT * FROM calendar_events"),
};

export const calState = { enabled: !!config.calendarName, calendar: config.calendarName, lastSyncAt: null, lastError: null, synced: 0 };

// ---- AppleScript snippets. Arguments come in through argv so no quoting problems with Hebrew / quotes.
const ENSURE_CAL = `
on run argv
  set calName to item 1 of argv
  tell application "Calendar"
    if not (exists calendar calName) then make new calendar with properties {name:calName}
    return "ok"
  end tell
end run`;

// argv: calName, uid-or-empty, title, y, m, d, hh, mm, durationMin, allDay(0/1), description, location, alarmMin
const UPSERT = `
on run argv
  set {calName, evUid, evTitle, y, mo, d, hh, mi, durMin, allDay, evDesc, evLoc, alarmMin} to argv
  set startDate to current date
  set year of startDate to (y as integer)
  set month of startDate to (mo as integer)
  set day of startDate to (d as integer)
  set hours of startDate to (hh as integer)
  set minutes of startDate to (mi as integer)
  set seconds of startDate to 0
  set endDate to startDate + ((durMin as integer) * minutes)
  tell application "Calendar"
    tell calendar calName
      set ev to missing value
      if evUid is not "" then
        try
          set ev to first event whose uid is evUid
        end try
      end if
      if ev is missing value then
        set ev to make new event with properties {summary:evTitle, start date:startDate, end date:endDate}
        if (alarmMin as integer) > 0 then
          tell ev to make new display alarm at end with properties {trigger interval:-(alarmMin as integer)}
        end if
      else
        set summary of ev to evTitle
        set start date of ev to startDate
        set end date of ev to endDate
      end if
      set allday event of ev to (allDay is "1")
      set description of ev to evDesc
      set location of ev to evLoc
      return uid of ev
    end tell
  end tell
end run`;

const DELETE = `
on run argv
  set {calName, evUid} to argv
  tell application "Calendar"
    tell calendar calName
      try
        delete (first event whose uid is evUid)
      end try
    end tell
  end tell
  return "ok"
end run`;

const TYPE_HE = { meeting: "פגישה", call: "שיחה", follow_up: "מעקב" };

function describe(it) {
  const lines = [];
  if (it.who) lines.push(`עם: ${it.who}`);
  if (it.chat_name && it.chat_name !== it.who) lines.push(`צ'אט: ${it.chat_name}`);
  if (it.notes) lines.push(it.notes);
  if (it.source_quote) lines.push(`„${it.source_quote}”`);
  lines.push("נוצר על ידי מעקב פגישות");
  return lines.join("\n");
}

function planned(it) {
  if (!it.when_iso) return null;
  const [date, time] = it.when_iso.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const allDay = it.all_day || !time;
  const [hh, mi] = allDay ? [9, 0] : time.split(":").map(Number);
  const title = `${it.type === "call" ? "📞 " : ""}${it.title}`;
  // all-day: end = start, which Calendar shows as a single day (start + 24h would spill into the next day)
  const durationMin = allDay ? 0 : it.type === "call" ? config.calendarCallMinutes : config.calendarMeetingMinutes;
  return { y, m, d, hh, mi, allDay, title, durationMin, description: describe(it), location: it.location || "" };
}

let running = false;
/** Bring the calendar in line with the items table. Safe to call often. */
export async function syncCalendar() {
  if (!calState.enabled || running) return;
  running = true;
  try {
    await run(ENSURE_CAL, [config.calendarName]);
    const items = store.allItems();
    const byId = new Map(items.map((i) => [i.id, i]));
    let touched = 0;

    // 1) open meetings/calls with a date -> create or update
    for (const it of items) {
      if (it.status !== "open" || it.type === "follow_up" || !it.when_iso) continue;
      const p = planned(it);
      const sig = JSON.stringify([p.title, it.when_iso, p.allDay, p.durationMin, p.description, p.location]);
      const row = q.get.get(it.id);
      if (row && row.signature === sig) continue;
      const uid = await run(UPSERT, [config.calendarName, row?.uid || "", p.title, String(p.y), String(p.m), String(p.d), String(p.hh), String(p.mi),
        String(p.durationMin), p.allDay ? "1" : "0", p.description, p.location, String(config.calendarAlarmMinutes)]);
      q.put.run(it.id, uid, sig);
      console.log(`  📅 ${row ? "updated" : "added"} in calendar: ${p.title} (${it.when_iso})`);
      touched++;
    }
    // 2) events whose item was cancelled, lost its date, or became a follow-up -> remove.
    //    Items marked done keep their event (the meeting happened).
    for (const row of q.all.all()) {
      const it = byId.get(row.item_id);
      const keep = it && (it.status === "open" || it.status === "done") && it.type !== "follow_up" && it.when_iso;
      if (keep) continue;
      await run(DELETE, [config.calendarName, row.uid]);
      q.del.run(row.item_id);
      console.log(`  📅 removed from calendar: ${it ? it.title : "item " + row.item_id}`);
      touched++;
    }
    calState.lastSyncAt = Date.now();
    calState.lastError = null;
    calState.synced = q.all.all().length;
    return touched;
  } catch (e) {
    calState.lastError = String(e.message).slice(0, 160);
    console.error("[calendar] sync failed:", calState.lastError);
  } finally {
    running = false;
  }
}

export const inCalendar = (itemId) => !!q.get.get(itemId);
