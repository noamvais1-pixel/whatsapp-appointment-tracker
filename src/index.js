import { config } from "./config.js";
import { startClient, getClient, state, sendToSelf, hardReconnect } from "./whatsapp.js";
import { startServer } from "./server.js";
import { processPending } from "./processor.js";
import { buildDigest, localDateKey } from "./digest.js";
import * as store from "./db.js";
import { checkNoReplies } from "./noreply.js";
import { closePastAppointments } from "./expire.js";
import { heartbeat } from "./whatsapp.js";
import { summary } from "./status.js";
import { notify } from "./notify.js";

if (!config.geminiKey) {
  console.error("\nGEMINI_API_KEY is not set. Open the .env file, paste your Gemini API key after GEMINI_API_KEY=, then run again.\n");
  process.exit(1);
}

console.log(`Model: ${config.geminiModel} | Timezone: ${config.timezone} | backfill: ${config.backfillDays} days | groups: ${config.ignoreGroups ? "ignored" : "included"}`);

// Keep the Mac from going to idle-sleep while the tracker runs (it cannot read messages while asleep).
// Closing the lid still sleeps the Mac. Set KEEP_AWAKE=false in .env to turn this off.
if ((process.env.KEEP_AWAKE || "true").toLowerCase() !== "false" && process.platform === "darwin") {
  import("node:child_process").then(({ spawn }) => {
    const c = spawn("caffeinate", ["-i", "-w", String(process.pid)], { detached: true, stdio: "ignore" });
    c.unref();
    console.log("[power] keeping the Mac awake while the tracker runs (KEEP_AWAKE=false to disable)");
  });
}

startServer(getClient);
startClient({
  onReady: () => {
    console.log("[tracker] watching for new messages");
    checkNoReplies().catch((e) => console.error("[noreply]", e.message));
  },
});
setInterval(() => {
  if (state.status !== "ready" || state.backfill) return;
  try { closePastAppointments(); } catch (e) { console.error("[expire]", e.message); }
  checkNoReplies().catch((e) => console.error("[noreply]", e.message));
}, 10 * 60_000);
try { closePastAppointments(); } catch (e) { console.error("[expire]", e.message); }

// Every 45 seconds, extract from chats whose newest message is at least 90s old (lets a back-and-forth finish first).
setInterval(async () => {
  if (state.status !== "ready" || state.backfill) return;
  try {
    await processPending({ minAgeSec: 90 });
  } catch (e) {
    console.error("[tracker] processing error:", e.message);
  }
}, 45_000);

// Optional daily agenda sent to your own WhatsApp number ("message yourself").
if (config.dailyDigestTime) {
  setInterval(async () => {
    const now = new Date();
    const hm = now.toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" });
    const today = localDateKey(now);
    if (hm !== config.dailyDigestTime || store.getMeta("last_digest_day") === today || state.status !== "ready") return;
    try {
      await sendToSelf(getClient(), buildDigest(now));
      store.setMeta("last_digest_day", today);
      console.log("[digest] sent today's agenda to your own WhatsApp");
    } catch (e) {
      console.error("[digest] failed:", e.message);
    }
  }, 30_000);
}

// Self-test every minute; if the Mac was asleep (the timer jumped), test immediately.
let lastTick = Date.now();
setInterval(() => {
  const gap = Date.now() - lastTick;
  lastTick = Date.now();
  if (gap > 3 * 60_000) console.log(`[power] the Mac was asleep for ~${Math.round(gap / 60_000)} min - checking the WhatsApp link`);
  heartbeat().catch((e) => console.error("[heartbeat]", e.message));
}, 60_000);
setTimeout(() => heartbeat().catch(() => {}), 20_000);

// Tell the user when the overall status changes (working <-> not working).
let lastLevel = null;
setInterval(() => {
  try {
    const s = summary();
    if (lastLevel && s.level !== lastLevel) {
      if (s.level === "bad") notify("מעקב פגישות - לא עובד", s.text);
      else if (lastLevel === "bad" && s.level === "ok") notify("מעקב פגישות", "חזר לעבוד: " + s.text);
    }
    lastLevel = s.level;
  } catch {}
}, 30_000);

// Watchdog: WhatsApp Web occasionally hangs while "loading chats" and never reports ready.
// If we sit in a connecting state for more than 3 minutes, restart the connection.
// A failed start or a dropped link ("disconnected") is retried after 1 minute.
let stuckSince = null;
setInterval(() => {
  const connecting = ["starting", "authenticating"].includes(state.status);
  const dropped = state.status === "disconnected";
  if (!connecting && !dropped) { stuckSince = null; return; }
  stuckSince ??= Date.now();
  const limit = dropped ? 60_000 : 3 * 60_000;
  if (Date.now() - stuckSince > limit) {
    stuckSince = null;
    hardReconnect(dropped ? "link dropped" : "connection hung").catch((e) => console.error("[watchdog] reconnect failed:", e.message));
  }
}, 30_000);

export async function shutdown() {
  console.log("\nShutting down...");
  try { await getClient()?.destroy(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
