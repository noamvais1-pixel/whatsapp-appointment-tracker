import dotenv from "dotenv";
dotenv.config({ quiet: true });
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const list = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  geminiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  geminiMinIntervalMs: Number(process.env.GEMINI_MIN_INTERVAL_MS || 13000),
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.5-flash",
  timezone: process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  backfillDays: Number(process.env.BACKFILL_DAYS || 14),
  ignoreGroups: (process.env.IGNORE_GROUPS || "true").toLowerCase() !== "false",
  onlyChats: list(process.env.ONLY_CHATS),
  skipChats: list(process.env.SKIP_CHATS),
  port: Number(process.env.PORT || 3123),
  // Blank = no password, dashboard open to the whole Wi-Fi network. See src/auth.js.
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "",
  // Requests from this Mac itself skip the password, so the desktop app keeps working.
  trustLocalhost: (process.env.DASHBOARD_TRUST_LOCALHOST || "true").toLowerCase() !== "false",
  // Interface to bind. Default 0.0.0.0 reaches the phone; 127.0.0.1 locks it to this Mac only.
  bindHost: process.env.BIND_HOST || "0.0.0.0",
  calendarName: process.env.CALENDAR_SYNC === "false" ? "" : (process.env.CALENDAR_NAME || "מעקב פגישות"),
  calendarMeetingMinutes: Number(process.env.CALENDAR_MEETING_MINUTES || 60),
  calendarCallMinutes: Number(process.env.CALENDAR_CALL_MINUTES || 30),
  calendarAlarmMinutes: Number(process.env.CALENDAR_ALARM_MINUTES ?? 30),
  autoUpdate: (process.env.AUTO_UPDATE || "true").toLowerCase() !== "false",
  autoUpdateHours: Number(process.env.AUTO_UPDATE_HOURS || 24),
  // Voice notes and pictures download by themselves as they arrive; the files are deleted from this Mac
  // after MEDIA_KEEP_DAYS (0 = keep forever).
  autoDownloadVoice: (process.env.AUTO_DOWNLOAD_VOICE || "true").toLowerCase() !== "false",
  autoDownloadImages: (process.env.AUTO_DOWNLOAD_IMAGES || "true").toLowerCase() !== "false",
  mediaKeepDays: Number(process.env.MEDIA_KEEP_DAYS ?? process.env.VOICE_KEEP_DAYS ?? 14),
  noReplyHours: Number(process.env.NO_REPLY_HOURS ?? 24),
  autoClosePastHours: Number(process.env.AUTO_CLOSE_PAST_HOURS ?? 12),
  dailyDigestTime: process.env.DAILY_DIGEST_TIME || "",
  chromePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  dbPath: path.join(DATA_DIR, "tracker.sqlite"),
  authDir: path.join(DATA_DIR, "whatsapp-session"),
};

/** includeGroups: the dashboard chat list shows groups even when IGNORE_GROUPS keeps them out of appointment scanning. */
export function chatAllowed(chat, { includeGroups = false } = {}) {
  if (chat.id?._serialized === "status@broadcast") return false; // other people's Status posts, not a chat
  if (config.ignoreGroups && chat.isGroup && !includeGroups) return false;
  const name = (chat.name || "").toLowerCase();
  const id = chat.id?.user || "";
  const matches = (needle) => {
    const n = needle.toLowerCase().replace(/[^a-z0-9+]/g, "");
    return (
      name.includes(needle.toLowerCase()) ||
      (n && id.replace(/[^0-9]/g, "").endsWith(n.replace(/[^0-9]/g, "")) && n.replace(/[^0-9]/g, "").length >= 6)
    );
  };
  if (config.skipChats.some(matches)) return false;
  if (config.onlyChats.length && !config.onlyChats.some(matches)) return false;
  return true;
}
