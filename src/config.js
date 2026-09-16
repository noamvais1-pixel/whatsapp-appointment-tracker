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
  noReplyHours: Number(process.env.NO_REPLY_HOURS ?? 24),
  autoClosePastHours: Number(process.env.AUTO_CLOSE_PAST_HOURS ?? 12),
  dailyDigestTime: process.env.DAILY_DIGEST_TIME || "",
  chromePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  dbPath: path.join(DATA_DIR, "tracker.sqlite"),
  authDir: path.join(DATA_DIR, "whatsapp-session"),
};

export function chatAllowed(chat) {
  if (config.ignoreGroups && chat.isGroup) return false;
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
