import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR } from "./config.js";
import * as store from "./db.js";
import { getClient, state } from "./whatsapp.js";

export const MEDIA_DIR = path.join(DATA_DIR, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const MAX_BYTES = 40 * 1024 * 1024;
const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav",
  "application/pdf": "pdf",
};
const findFfmpeg = () => ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p)) || null;
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, (err) => (err ? rej(err) : res())));

const queue = [];
const queued = new Set();
let working = false;

/** Download attachments for these message ids in the background (skips ones already stored). */
export function queueMedia(ids, { first = false } = {}) {
  for (const id of ids) {
    if (queued.has(id) || store.getMedia(id)) continue;
    queued.add(id);
    if (first) queue.unshift(id); else queue.push(id);
  }
  if (!working) drain();
}

async function drain() {
  working = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      if (!getClient() || state.status !== "ready") {
        // not linked yet (e.g. right after start): keep it queued and check again shortly
        queue.push(id);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      try {
        await download(id);
      } catch (e) {
        const msg = String(e.message);
        console.warn(`[media] ${id.slice(-24)}: ${msg.slice(0, 100)}`);
        const friendly = /timed out|unavailable|expired/i.test(msg)
          ? "וואטסאפ לא סיפק את הקובץ (הודעה ישנה או הטלפון לא זמין)"
          : msg.slice(0, 200);
        store.saveMedia({ msg_id: id, status: "failed", error: friendly });
      } finally {
        queued.delete(id);
      }
    }
  } finally {
    working = false;
  }
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

async function download(id) {
  const client = getClient();
  if (!client || state.status !== "ready") throw new Error("WhatsApp not linked");
  console.log(`[media] downloading ${id.slice(-24)}`);
  const msg = await withTimeout(client.getMessageById(id), 30000, "finding the message");
  if (!msg) throw new Error("message not found");
  if (!msg.hasMedia) throw new Error("no media on this message");
  const declared = msg._data?.size || 0;
  if (declared > MAX_BYTES) {
    store.saveMedia({ msg_id: id, status: "too_large", size: declared, filename: msg._data?.filename ?? null });
    return;
  }
  const m = await withTimeout(msg.downloadMedia(), 60000, "download");
  if (!m || !m.data) throw new Error("media unavailable (expired on WhatsApp's side)");
  const buf = Buffer.from(m.data, "base64");
  const base = (m.mimetype || "application/octet-stream").split(";")[0].trim();
  const ext = EXT[base] || (m.filename ? path.extname(m.filename).slice(1) : "") || "bin";
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, "_");
  let file = path.join(MEDIA_DIR, `${safe}.${ext}`);
  let mimetype = base;
  fs.writeFileSync(file, buf);

  // WhatsApp voice notes are Ogg/Opus, which the app window cannot play; convert to m4a when ffmpeg is installed.
  if (base === "audio/ogg" || base === "audio/opus") {
    const ff = findFfmpeg();
    if (ff) {
      const out = path.join(MEDIA_DIR, `${safe}.m4a`);
      // +faststart puts the index at the front of the file; without it Safari/WebKit plays a moment and jumps back to the start
      await run(ff, ["-y", "-loglevel", "error", "-i", file, "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", out]);
      file = out;
      mimetype = "audio/mp4";
    }
  }
  store.saveMedia({ msg_id: id, status: "ok", mimetype, filename: m.filename || msg._data?.filename || null, path: file, size: buf.length });
}

export const isQueued = (id) => queued.has(id);

/** Keep WhatsApp's own small blurred preview (sent with image/video messages) so the chat can show it without downloading. */
export function rememberThumb(rec) {
  if (!rec.thumb || store.getMedia(rec.id)) return;
  try {
    const safe = rec.id.replace(/[^A-Za-z0-9_.-]/g, "_");
    const file = path.join(MEDIA_DIR, `${safe}.thumb.jpg`);
    fs.writeFileSync(file, Buffer.from(rec.thumb, "base64"));
    store.saveMedia({ msg_id: rec.id, status: "thumb", mimetype: "image/jpeg", path: file, size: null });
  } catch {}
}

/** Open a downloaded file with the Mac's default app (Preview, QuickTime, PDF viewer...). */
export async function openMedia(id) {
  const row = store.getMedia(id);
  if (!row || row.status !== "ok" || !fs.existsSync(row.path)) throw new Error("file not available");
  await run("open", [row.path]);
}

/** User asked for this one attachment. */
export function requestMedia(id) {
  const row = store.getMedia(id);
  if (row && row.status === "ok") return;
  if (row) store.deleteMedia(id); // thumb / failed / too_large -> try the real thing
  queueMedia([id], { first: true });
}
export const retryMedia = requestMedia;
