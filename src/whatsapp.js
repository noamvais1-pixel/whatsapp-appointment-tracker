import pkg from "whatsapp-web.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import { config, chatAllowed } from "./config.js";
import * as store from "./db.js";
import { processPending } from "./processor.js";
import { notify } from "./notify.js";

const { Client, LocalAuth } = pkg;

export const state = {
  status: "starting", // starting | qr | authenticating | ready | disconnected | switching
  qrDataUrl: null,
  me: null,
  backfill: null, // { total, done, chat }
  lastError: null,
  health: {
    whatsapp: null, gemini: null,          // human-readable problems, or null
    lastOkAt: null, readErrors: 0,         // last successful chat read
    lastMessageAt: null,                   // last message seen arriving (in or out)
    lastHeartbeatAt: null, heartbeatFails: 0, // last time the WhatsApp page proved it is alive
    lastGeminiOkAt: null, lastNoReplyCheckAt: null,
    startedAt: Date.now(),
  },
};

// Errors that look like the WhatsApp library being out of step with WhatsApp Web
// (minified one-letter errors, failed page evaluation, missing internal functions).
const looksLikeBreakage = (msg) => /^[a-z]{1,2}$/i.test(msg.trim()) || /Evaluation failed|is not a function|Cannot read propert|Execution context/i.test(msg);

export function reportRead(ok, err) {
  const h = state.health;
  if (ok) {
    h.readErrors = 0; h.lastOkAt = Date.now();
    if (h.whatsapp) { h.whatsapp = null; console.log("[health] WhatsApp reading works again"); }
    return;
  }
  h.readErrors++;
  const msg = String(err?.message || err);
  // The WhatsApp Web page reloaded underneath us and the library kept a stale handle:
  // every read now fails with "detached Frame". Treat it as a dropped link so the watchdog reconnects.
  if (h.readErrors >= 4 && transientPage(msg) && state.status === "ready") {
    state.status = "disconnected";
    state.lastError = "החיבור לוואטסאפ התנתק מאחורי הקלעים";
    console.warn("[health] page handle is stale (detached frame) - marking link as dropped so it reconnects");
    return;
  }
  if (h.readErrors >= 2 && looksLikeBreakage(msg) && !h.whatsapp) {
    h.whatsapp = "התוכנה מחוברת אבל לא מצליחה לקרוא הודעות. כנראה וואטסאפ שינה משהו וצריך עדכון של התוכנה.";
    console.error(`[health] WhatsApp reading is broken (error "${msg.slice(0, 60)}")`);
    notify("מעקב פגישות - בעיה", "וואטסאפ שינה משהו; התוכנה לא מצליחה לקרוא הודעות. צריך עדכון.");
  }
}
export function reportGemini(ok, err) {
  const h = state.health;
  if (ok) { h.lastGeminiOkAt = Date.now(); if (h.gemini) { h.gemini = null; console.log("[health] Gemini works again"); } return; }
  const msg = String(err?.message || err);
  const quota = /RESOURCE_EXHAUSTED|quota/i.test(msg);
  const text = /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)
    ? "מפתח ה-Gemini לא תקין. יש לבדוק את GEMINI_API_KEY בקובץ .env."
    : quota ? "מכסת Gemini החינמית נגמרה להיום; הקריאה תמשיך כשהמכסה תתחדש (או להפעיל חיוב על המפתח)."
    : `Gemini לא זמין כרגע: ${msg.slice(0, 80)}`;
  if (h.gemini !== text) {
    h.gemini = text;
    console.error(`[health] Gemini problem: ${text}`);
    if (!quota) notify("מעקב פגישות - בעיה", text);
  }
}

function senderName(msg, chat) {
  if (msg.fromMe) return "Me";
  if (!chat.isGroup) return chat.name || msg.from;
  return msg._data?.notifyName || msg.author || "Someone";
}

const MEDIA_TYPES = new Set(["image", "video", "ptt", "audio", "document", "sticker"]);
function messageText(msg) {
  if (msg.type === "chat") return msg.body;
  const caption = msg.body ? ` ${msg.body}` : "";
  if (msg.type === "image") return `[תמונה]${caption}`;
  if (msg.type === "video") return `[סרטון]${caption}`;
  if (msg.type === "ptt") return "[הודעה קולית]";
  if (msg.type === "audio") return "[קובץ שמע]";
  if (msg.type === "document") return `[קובץ${msg._data?.filename ? ": " + msg._data.filename : ""}]${caption}`;
  if (msg.type === "sticker") return "[סטיקר]";
  if (msg.type === "location") return "[shared a location]";
  if (msg.type === "vcard") return "[shared a contact]";
  return null; // reactions, call logs, etc.
}
/** Save a message record plus its preview thumbnail (if any). Returns true when the message is new. */
export function storeRecord(rec, processed = 0) {
  const isNew = store.saveMessage(rec, processed);
  if (rec.thumb) import("./media.js").then((m) => m.rememberThumb(rec));
  return isNew;
}
export const mediaKind = (msg) => (MEDIA_TYPES.has(msg.type) && msg.hasMedia ? msg.type : null);

export function toRecord(msg, chat) {
  const body = messageText(msg);
  if (!body || !body.trim()) return null;
  return {
    id: msg.id._serialized,
    chatId: chat.id._serialized,
    chatName: chat.name || chat.id.user,
    fromMe: !!msg.fromMe,
    sender: senderName(msg, chat),
    body,
    ts: msg.timestamp,
    mediaType: mediaKind(msg),
    // for images/videos WhatsApp ships a tiny base64 JPEG preview in the raw body
    thumb: ["image", "video"].includes(msg.type) && typeof msg._data?.body === "string" && msg._data.body.length > 200 && !/\s/.test(msg._data.body) ? msg._data.body : null,
  };
}

let current = null;
let readyHook = null;
export const getClient = () => current;

/** Start (or restart) the WhatsApp client. */
export function startClient({ onReady } = {}) {
  if (onReady) readyHook = onReady;
  state.status = "starting";
  state.qrDataUrl = null;
  state.me = null;
  state.lastError = null;
  current = createClient({ onReady: readyHook });
  current.initialize().catch((e) => {
    state.status = "disconnected";
    state.lastError = String(e.message || e);
    console.error("[whatsapp] failed to start:", e.message);
  });
  return current;
}

/**
 * Unlink the current phone and show a fresh QR code for another one.
 * Logs the linked device out on the phone when possible, removes the saved session,
 * optionally wipes the messages and items that came from the old phone.
 */
export async function relink({ clearData = false } = {}) {
  state.status = "switching";
  state.qrDataUrl = null;
  const old = current;
  current = null;
  if (old) {
    try { await withTimeout(old.logout(), 15000); console.log("[whatsapp] logged out of the old phone"); }
    catch (e) { console.warn("[whatsapp] logout skipped:", String(e.message).slice(0, 100)); }
    try { await withTimeout(old.destroy(), 15000); } catch {}
  }
  try { fs.rmSync(config.authDir, { recursive: true, force: true }); } catch {}
  if (clearData) {
    store.wipeAll();
    console.log("[whatsapp] cleared messages and items from the previous phone");
  }
  startClient();
}

/**
 * Active self-test: ask the hidden WhatsApp page whether it is alive and connected.
 * Two failures in a row mean the page is dead (typically after the Mac slept) -> reconnect.
 */
export async function heartbeat() {
  const h = state.health;
  if (state.status !== "ready" || !current) return false;
  try {
    const alive = await withTimeout(current.pupPage.evaluate(() => 1 + 1), 10000);
    const st = await withTimeout(current.getState(), 15000);
    if (alive !== 2 || st !== "CONNECTED") throw new Error(`state ${st}`);
    h.lastHeartbeatAt = Date.now();
    h.heartbeatFails = 0;
    return true;
  } catch (e) {
    h.heartbeatFails++;
    console.warn(`[heartbeat] WhatsApp page did not answer (${h.heartbeatFails}): ${String(e.message).slice(0, 80)}`);
    if (h.heartbeatFails >= 2) {
      h.heartbeatFails = 0;
      await hardReconnect("self-test failed");
    }
    return false;
  }
}

/** Reconnect from scratch: close the old client, kill any hidden Chrome still holding the login folder, start again. */
export async function hardReconnect(reason = "") {
  console.warn(`[whatsapp] reconnecting${reason ? ` (${reason})` : ""}`);
  const old = current;
  current = null;
  state.status = "starting";
  state.lastError = null;
  if (old) {
    try { await withTimeout(old.destroy(), 10000); }
    catch (e) { console.warn("[whatsapp] old client did not close cleanly:", String(e.message).slice(0, 80)); }
  }
  await killStaleBrowser();
  startClient();
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, () => resolve()));
async function killStaleBrowser() {
  // A Chrome that is still holding our profile folder blocks every new launch ("browser is already running").
  await run("pkill", ["-TERM", "-f", config.authDir]);
  await sleep(4000);
  await run("pkill", ["-KILL", "-f", config.authDir]);
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.rmSync(path.join(config.authDir, "session", f), { force: true }); } catch {}
  }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);

function createClient({ onReady } = {}) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir }),
    puppeteer: {
      headless: true,
      executablePath: config.chromePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });

  client.on("qr", async (qr) => {
    state.status = "qr";
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 320 });
    console.log("\nScan this QR code with the phone whose WhatsApp you want to track:");
    console.log("WhatsApp > Settings (or the three dots) > Linked devices > Link a device\n");
    qrcodeTerminal.generate(qr, { small: true });
    console.log(`(You can also open http://localhost:${config.port} to scan it from the dashboard.)\n`);
  });
  client.on("authenticated", () => { state.status = "authenticating"; state.qrDataUrl = null; console.log("[whatsapp] authenticated, loading chats..."); });
  client.on("auth_failure", (m) => { state.status = "disconnected"; state.lastError = String(m); console.error("[whatsapp] auth failure:", m); });
  client.on("disconnected", (r) => {
    if (current && current !== client) return; // an old client going away during a phone switch
    state.status = "disconnected"; state.lastError = String(r); console.error("[whatsapp] disconnected:", r);
  });

  client.on("ready", async () => {
    state.status = "ready";
    state.health.readErrors = 0;
    state.qrDataUrl = null;
    state.me = client.info?.pushname || client.info?.wid?.user || "me";
    console.log(`[whatsapp] linked as ${state.me}`);
    await sleep(8000); // WhatsApp Web reloads itself right after linking; reading during that fails
    heartbeat().catch(() => {}); // prove the link is alive right away so the status line is honest from the start
    await runBackfill();
    onReady?.(client);
    processPending().catch((e) => console.error("[process]", e.message)); // analyse whatever the read found, in the background
  });

  // message_create fires for both incoming and outgoing messages
  client.on("message_create", async (msg) => {
    try {
      if (msg.isStatus || msg.from === "status@broadcast") return;
      const chat = await msg.getChat();
      if (!chatAllowed(chat)) return;
      const rec = toRecord(msg, chat);
      reportRead(true);
      state.health.lastMessageAt = Date.now();
      if (rec && storeRecord(rec)) {
        console.log(`[msg] ${rec.chatName} / ${rec.sender}: ${rec.body.slice(0, 80)}`);
        if (!rec.fromMe && store.closeNoReply(rec.chatId)) console.log(`  x [done] ${rec.chatName} replied - reminder closed`);
      }
    } catch (e) {
      console.error("[whatsapp] message handling error:", e.message);
      reportRead(false, e);
    }
  });

  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transientPage = (e) => /detached Frame|Execution context|Target closed|Session closed|Protocol error/i.test(String(e?.message || e));

let backfillRunning = false;
/** Read recent messages from every allowed chat (since the last read). Safe to call any time; retries page reloads. */
export async function runBackfill() {
  if (backfillRunning || !current || state.status !== "ready") return false;
  backfillRunning = true;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await backfill(current);
        reportRead(true);
        return true;
      } catch (e) {
        console.error(`[whatsapp] backfill error (attempt ${attempt}): ${e.message}`);
        if (transientPage(e)) {
          // the page reloaded under us; retrying on the stale handle never works - reconnect and resume on "ready"
          if (attempt >= 2 && state.status === "ready") {
            state.status = "disconnected";
            state.lastError = "וואטסאפ ווב נטען מחדש באמצע הקריאה; מתחבר מחדש וממשיך";
            console.warn("[whatsapp] page reloaded during backfill - reconnecting, the read will resume");
            return false;
          }
          await sleep(10000);
          continue;
        }
        reportRead(false, e); reportRead(false, e);
        return false;
      }
    }
  } finally {
    backfillRunning = false;
    state.backfill = null;
  }
  return false;
}

let chatListCache = { at: 0, list: [] };
/** Chat list for the dashboard (live from WhatsApp when linked, else from stored messages). */
export async function listChats() {
  if (current && state.status === "ready") {
    if (Date.now() - chatListCache.at < 15000) return chatListCache.list;
    try {
      const chats = await current.getChats();
      const list = chats
        .filter((c) => c.id._serialized !== "status@broadcast" && chatAllowed(c))
        .map((c) => ({
          id: c.id._serialized,
          name: c.name || c.id.user,
          isGroup: !!c.isGroup,
          timestamp: c.timestamp || 0,
          unread: c.unreadCount || 0,
          last_body: c.lastMessage ? (messageText(c.lastMessage) || "") : "",
          last_from_me: !!c.lastMessage?.fromMe,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
      chatListCache = { at: Date.now(), list };
      reportRead(true);
      return list;
    } catch (e) {
      console.warn("[chats] could not list chats:", String(e.message).slice(0, 100));
      reportRead(false, e);
    }
  }
  return store.chatSummaries().map((c) => ({ ...c, isGroup: false, unread: 0, last_from_me: !!c.last_from_me }));
}

async function fetchWithRetry(chat, opts) {
  try { return await chat.fetchMessages(opts); }
  catch (e) { if (!transientPage(e)) throw e; await sleep(6000); return chat.fetchMessages(opts); }
}

async function backfill(client) {
  const cutoff = Math.floor(Date.now() / 1000) - config.backfillDays * 86400;
  const lastBackfill = Number(store.getMeta("last_backfill_ts") || 0);
  const since = Math.max(cutoff, lastBackfill - 3600); // small overlap; duplicates are ignored by the DB
  const all = (await client.getChats()).filter((c) => chatAllowed(c) && c.id._serialized !== "status@broadcast");
  // only chats with activity since the last read need reading; the rest are skipped without counting
  const chats = all.filter((c) => (c.timestamp || 0) >= since);
  state.backfill = { total: chats.length, done: 0, chat: null };
  console.log(`[backfill] ${chats.length} of ${all.length} chats have activity since ${new Date(since * 1000).toLocaleString()}`);
  let failed = 0;

  for (const chat of chats) {
    state.backfill.chat = chat.name;
    try {
      let msgs = await fetchWithRetry(chat, { limit: 100 });
      if (msgs.length === 100 && msgs[0].timestamp > since) msgs = await fetchWithRetry(chat, { limit: 400 });
      let added = 0;
      for (const m of msgs) {
        if (m.timestamp < since) continue;
        const rec = toRecord(m, chat);
        if (rec && storeRecord(rec)) added++;
      }
      if (added) console.log(`[backfill] ${chat.name}: ${added} new messages`);
    } catch (e) {
      console.error(`[backfill] ${chat.name}: ${e.message}`);
      if (transientPage(e)) throw e; // the page reloaded under us - let runBackfill retry the whole pass
      failed++;
    }
    state.backfill.done++;
  }
  if (failed === 0) store.setMeta("last_backfill_ts", Math.floor(Date.now() / 1000)); // a pass with failures gets re-read next time
  state.backfill = null;
  console.log(`[backfill] finished${failed ? ` (${failed} chats could not be read; they will be retried)` : ""}`);
}

export async function sendToSelf(client, text) {
  client = client || current;
  const me = client?.info?.wid?._serialized;
  if (!me) throw new Error("not linked");
  await client.sendMessage(me, text);
}
