// Spelling suggestions for the dashboard's text boxes, from the Mac's own speller (Hebrew + English).
// spell-helper.swift is compiled once into .build/ (Xcode Command Line Tools, already needed for the
// app window) and kept running; requests go over its stdin/stdout one JSON line at a time.
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { ROOT } from "./config.js";

const SRC = path.join(ROOT, "src", "spell-helper.swift");
const BIN = path.join(ROOT, ".build", "spell-helper");
const TIMEOUT_MS = 4000;

export const spellState = { ready: false, error: null };
let building = null;
let proc = null;
let buf = "";
let seq = 0;
const waiting = new Map();

function build() {
  const fresh = () => { try { return fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs; } catch { return false; } };
  if (fresh()) return Promise.resolve();
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  return new Promise((res, rej) =>
    execFile("/usr/bin/swiftc", ["-O", "-o", BIN, SRC, "-framework", "AppKit"], { timeout: 180000 }, (err, so, se) =>
      err ? rej(new Error(String(se || err.message).trim().split("\n").pop())) : res()));
}

function start() {
  proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "ignore"] });
  buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      } catch {}
    }
  });
  proc.stdin.on("error", () => {});
  proc.on("exit", () => {
    proc = null;
    for (const done of waiting.values()) done({ error: "speller stopped" });
    waiting.clear();
  });
}

async function ask(req) {
  if (!building) {
    building = build().then(() => { spellState.ready = true; console.log("[spell] Mac speller ready"); })
      .catch((e) => { spellState.error = e.message; console.error("[spell] helper build failed:", e.message); });
  }
  await building;
  if (!spellState.ready) return { error: spellState.error };
  if (!proc) start();
  const id = ++seq;
  return new Promise((res) => {
    const timer = setTimeout(() => { waiting.delete(id); res({ error: "timeout" }); }, TIMEOUT_MS);
    waiting.set(id, (msg) => { clearTimeout(timer); res(msg); });
    proc.stdin.write(JSON.stringify({ id, ...req }) + "\n");
  });
}

/** Words the speller does not know, each with up to 4 suggestions. */
export async function checkSpelling(text) {
  const r = await ask({ op: "check", text: String(text || "").slice(0, 5000) });
  // unavailable: the helper could not be built (no Command Line Tools) - the page stops asking
  return r.error ? { ok: false, error: r.error, unavailable: !spellState.ready, issues: [] } : { ok: true, issues: r.issues || [] };
}

/** "This word is right" - adds it to the Mac's spelling dictionary (shared with every Mac app). */
export async function learnWord(word) {
  const r = await ask({ op: "learn", word: String(word || "").slice(0, 80) });
  return { ok: !r.error, error: r.error };
}

/** Compile the helper in the background at startup, so the first check does not wait for it. */
export function warmUpSpelling() {
  ask({ op: "check", text: "" }).catch(() => {});
}
