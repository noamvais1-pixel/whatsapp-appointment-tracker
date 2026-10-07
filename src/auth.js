// Shared-password gate for the dashboard.
//
// Why this exists: the dashboard serves raw WhatsApp message content - bank details, ID
// numbers, phone numbers, addresses. Express's app.listen(port) binds 0.0.0.0/:: , so the
// dashboard is reachable by every device on the Wi-Fi network, not just this Mac. Without a
// gate, anyone on the same network who opens http://<this-mac>:3123 reads everything.
//
// Turn it off:  leave DASHBOARD_PASSWORD blank in .env (or delete the line) and restart.
// Requests from this Mac itself (127.0.0.1 / ::1) skip the gate by default, so the desktop
// app and a browser on the Mac keep working untouched. DASHBOARD_TRUST_LOCALHOST=false
// requires the password there too.
//
// This is a bolt on the door, not a safe. The connection is plain HTTP, so the password and
// everything it protects cross the local network unencrypted. It stops a housemate or a
// stranger on cafe Wi-Fi from browsing the data; it does not stop someone capturing traffic.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, DATA_DIR } from "./config.js";

const COOKIE = "apt_session";
const MAX_AGE_SEC = 30 * 24 * 3600;

// Per-install random secret, so the cookie value is not a guessable function of the password
// and so cookies stop working if the data directory is wiped.
let secret = null;
function getSecret() {
  if (secret) return secret;
  const file = path.join(DATA_DIR, "session-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return (secret = existing);
  } catch {}
  secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const tokenFor = (password) =>
  crypto.createHmac("sha256", getSecret()).update(String(password)).digest("hex");

function sameValue(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  // Compare a fixed-size digest of each side so differing lengths cannot throw and the
  // comparison itself leaks nothing about length.
  const hx = crypto.createHash("sha256").update(x).digest();
  const hy = crypto.createHash("sha256").update(y).digest();
  return crypto.timingSafeEqual(hx, hy);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

const isLoopback = (req) => {
  const ip = (req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "";
};

// Paths that must work before sign-in: the login page itself, and the icons/manifest so
// "Add to Home Screen" can render. None of them expose any message data.
const OPEN_PATHS = new Set([
  "/login",
  "/manifest.webmanifest",
  "/icon-180.png",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.ico",
]);

export const authEnabled = () => Boolean(config.dashboardPassword);

const LOGIN_PAGE = (error) => /* html */ `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>פגישות ומעקבים</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Helvetica,Arial,sans-serif;color:#17181c;
    background:#eaedf3;background-image:
      radial-gradient(900px 600px at 85% -10%,rgba(120,190,255,.55),transparent 60%),
      radial-gradient(700px 500px at -10% 30%,rgba(120,240,200,.45),transparent 60%),
      radial-gradient(800px 600px at 60% 110%,rgba(200,170,255,.45),transparent 60%)}
  form{width:100%;max-width:360px;padding:26px 22px;border-radius:22px;background:rgba(255,255,255,.62);
    -webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);
    border:1px solid rgba(255,255,255,.65);box-shadow:0 12px 32px rgba(25,35,70,.14)}
  h1{font-size:19px;margin:0 0 4px}
  p{margin:0 0 18px;font-size:13.5px;color:#5f6470}
  input{width:100%;font:inherit;font-size:16px;padding:12px 14px;margin-bottom:12px;min-height:46px;
    border:1px solid rgba(255,255,255,.7);border-radius:14px;background:rgba(255,255,255,.8);color:#17181c;outline:none}
  input:focus{border-color:rgba(27,122,74,.5);box-shadow:0 0 0 3px rgba(27,122,74,.15)}
  button{width:100%;font:inherit;font-weight:600;min-height:46px;padding:12px;border-radius:99px;cursor:pointer;
    border:1px solid rgba(255,255,255,.35);color:#fff;background:linear-gradient(135deg,#2fb673,#1b7a4a);
    box-shadow:0 6px 18px rgba(27,122,74,.28)}
  .err{background:rgba(255,150,120,.35);color:#7a2e10;border-radius:14px;padding:10px 14px;margin-bottom:14px;font-size:14px;font-weight:600}
  @media (prefers-color-scheme:dark){
    body{color:#f1f2f6;background:#171a22;background-image:
      radial-gradient(900px 600px at 85% -10%,rgba(60,120,220,.45),transparent 60%),
      radial-gradient(700px 500px at -10% 30%,rgba(40,170,130,.35),transparent 60%)}
    form{background:rgba(30,34,44,.6);border-color:rgba(255,255,255,.14)}
    p{color:#a7acb8}
    input{background:rgba(50,55,68,.75);border-color:rgba(255,255,255,.14);color:#f1f2f6}
    .err{background:rgba(200,80,50,.3);color:#ffd9cc}
  }
</style></head><body>
<form method="post" action="/login">
  <h1>פגישות ומעקבים</h1>
  <p>הדף הזה מציג הודעות ופרטים אישיים. צריך סיסמה כדי להיכנס מהרשת.</p>
  ${error ? `<div class="err">סיסמה שגויה. אפשר לנסות שוב.</div>` : ""}
  <input type="password" name="password" autocomplete="current-password" autofocus
         placeholder="סיסמה" aria-label="סיסמה">
  <button type="submit">כניסה</button>
</form>
</body></html>`;

/**
 * Mounts the login routes and the gate. Call before the JSON body parser and before any
 * data route, so unauthenticated requests never reach them.
 */
export function installAuth(app, express) {
  if (!authEnabled()) {
    console.log("[auth] DASHBOARD_PASSWORD is blank - the dashboard is open to everyone on this Wi-Fi network");
    return;
  }

  app.get("/login", (req, res) => {
    if (isAuthed(req)) return res.redirect("/");
    res.type("html").send(LOGIN_PAGE(req.query.bad === "1"));
  });

  app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    if (!sameValue(req.body?.password, config.dashboardPassword)) {
      // Slow brute force from the network down to something impractical over HTTP.
      return setTimeout(() => res.redirect("/login?bad=1"), 600);
    }
    res.setHeader("Set-Cookie", [
      `${COOKIE}=${tokenFor(config.dashboardPassword)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${MAX_AGE_SEC}`,
    ].join("; "));
    res.redirect("/");
  });

  app.post("/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect("/login");
  });

  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path) || isAuthed(req)) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
    res.redirect("/login");
  });

  console.log("[auth] dashboard password is set" + (config.trustLocalhost ? " (requests from this Mac skip it)" : ""));
}

function isAuthed(req) {
  if (config.trustLocalhost && isLoopback(req)) return true;
  const got = readCookie(req, COOKIE);
  return Boolean(got) && sameValue(got, tokenFor(config.dashboardPassword));
}
