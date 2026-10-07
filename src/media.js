import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR, config } from "./config.js";
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
    const row = store.getMedia(id);
    if (queued.has(id) || (row && row.status !== "thumb")) continue;
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
  makePreview(id).catch(() => {});
}

const autoTypes = () => [config.autoDownloadVoice && "ptt", config.autoDownloadImages && "image"].filter(Boolean);
const AUTO_LABEL = { ptt: "הודעה קולית", image: "תמונה" };

/**
 * Voice notes and pictures: download the recent ones that are not on this Mac yet, and delete the files of
 * ones downloaded more than MEDIA_KEEP_DAYS ago (the message stays; the chat offers to download it again).
 */
export function maintainAutoMedia() {
  const days = config.mediaKeepDays;
  const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
  if (autoTypes().length) queueMedia(store.autoMediaToFetch(autoTypes(), since));
  if (!days) return;
  let n = 0;
  for (const row of store.oldAutoMedia(["ptt", "image"], days)) {
    const safe = row.msg_id.replace(/[^A-Za-z0-9_.-]/g, "_");
    // the file itself, the original .ogg a voice note was converted from, and a picture's blurred preview
    for (const f of [row.path, row.thumb, path.join(MEDIA_DIR, `${safe}.ogg`), path.join(MEDIA_DIR, `${safe}.thumb.jpg`)]) {
      try { if (f) fs.rmSync(f, { force: true }); } catch {}
    }
    store.saveMedia({ msg_id: row.msg_id, status: "expired", error: `נמחק מהמחשב אחרי ${days} ימים` });
    n++;
  }
  if (n) console.log(`[media] deleted ${n} voice notes / pictures older than ${days} days`);
}

/** A voice note or picture that just arrived: fetch it right away. */
export function autoDownload(rec) {
  if (!autoTypes().includes(rec.mediaType)) return;
  if (config.mediaKeepDays && rec.ts < Date.now() / 1000 - config.mediaKeepDays * 86400) return;
  queueMedia([rec.id]);
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

/**
 * First-page / first-frame preview of a downloaded document or video, made by macOS Quick Look
 * (the same previews Finder shows). Returns the PNG path or null.
 */
export async function makePreview(id) {
  const row = store.getMedia(id);
  if (!row || row.status !== "ok" || !row.path || !fs.existsSync(row.path)) return null;
  if (row.thumb && fs.existsSync(row.thumb)) return row.thumb;
  const mime = row.mimetype || "";
  if (mime.startsWith("image/") || mime.startsWith("audio/")) return null;
  const outDir = path.join(MEDIA_DIR, "previews");
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await run("qlmanage", ["-t", "-s", "640", "-o", outDir, row.path]);
    const made = path.join(outDir, path.basename(row.path) + ".png");
    if (!fs.existsSync(made)) return null;
    store.setMediaThumb(id, made);
    return made;
  } catch {
    return null;
  }
}

/** Quick Look preview for a file that is about to be sent (not stored anywhere). Returns PNG bytes or null. */
export async function previewBytes(name, base64) {
  const tmpDir = path.join(MEDIA_DIR, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const ext = (path.extname(name || "") || ".bin").toLowerCase();
  const file = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    await run("qlmanage", ["-t", "-s", "480", "-o", tmpDir, file]);
    const png = file + ".png";
    return fs.existsSync(png) ? fs.readFileSync(png) : null;
  } catch {
    return null;
  } finally {
    for (const f of [file, file + ".png"]) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
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
