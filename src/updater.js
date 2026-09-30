/**
 * Self-update: once a day (and on demand) look at the project's GitHub repository. If a newer
 * version was published, pull it, reinstall dependencies (which re-applies the WhatsApp library
 * patches) and restart the tracker cleanly. Nothing happens when the local copy has uncommitted
 * changes - those are never overwritten.
 */
import { execFile, spawn } from "node:child_process";
import { ROOT, config } from "./config.js";
import { state } from "./whatsapp.js";
import { busy } from "./processor.js";

const run = (cmd, args, timeout = 120000) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd: ROOT, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split("\n").pop())) : resolve(stdout.trim()),
    ),
  );

export const updState = {
  enabled: config.autoUpdate,
  lastCheckAt: null,
  lastResult: null,      // "up-to-date" | "updated" | "local-changes" | "error" | "postponed"
  lastError: null,
  current: null,         // short commit id running now
  available: null,       // short commit id waiting on GitHub, if any
  updatedAt: null,
};

let running = false;

/** Check GitHub; apply the update when there is one and it is safe to restart. */
export async function checkForUpdates({ apply = true } = {}) {
  if (!updState.enabled || running) return updState;
  running = true;
  try {
    updState.lastCheckAt = Date.now();
    updState.current = await run("git", ["rev-parse", "--short", "HEAD"]);
    await run("git", ["fetch", "--quiet", "origin", "main"], 90000);
    const remote = await run("git", ["rev-parse", "--short", "origin/main"]);
    const behind = Number(await run("git", ["rev-list", "--count", "HEAD..origin/main"]));
    updState.available = behind > 0 ? remote : null;
    if (behind === 0) { updState.lastResult = "up-to-date"; updState.lastError = null; return updState; }

    const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) {
      updState.lastResult = "local-changes";
      updState.lastError = "יש שינויים מקומיים שלא נשמרו ב-GitHub, לכן העדכון לא הופעל";
      console.warn("[update] new version available but local changes present - not updating");
      return updState;
    }
    if (!apply) { updState.lastResult = "available"; return updState; }
    if (state.backfill || busy) {
      updState.lastResult = "postponed";
      console.log("[update] new version available; will apply once the app is idle");
      setTimeout(() => checkForUpdates(), 10 * 60_000);
      return updState;
    }

    console.log(`[update] updating ${updState.current} -> ${remote}`);
    await run("git", ["pull", "--ff-only", "--quiet", "origin", "main"], 120000);
    await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], 600000);
    updState.lastResult = "updated";
    updState.updatedAt = Date.now();
    updState.lastError = null;
    console.log("[update] installed; restarting in 5 seconds");
    // A detached helper relaunches the tracker after this process has quit cleanly.
    spawn("/bin/bash", ["-c", `sleep 6; /bin/bash "${ROOT}/launch.sh" --no-open`], { detached: true, stdio: "ignore", cwd: ROOT }).unref();
    setTimeout(async () => { try { (await import("./index.js")).shutdown(); } catch { process.exit(0); } }, 5000);
    return updState;
  } catch (e) {
    updState.lastResult = "error";
    updState.lastError = String(e.message).slice(0, 160);
    console.warn("[update] check failed:", updState.lastError);
    return updState;
  } finally {
    running = false;
  }
}

export function startUpdater() {
  if (!updState.enabled) return;
  setTimeout(() => checkForUpdates(), 3 * 60_000);                  // shortly after start
  setInterval(() => checkForUpdates(), config.autoUpdateHours * 3600_000);
}
