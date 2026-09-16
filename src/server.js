import express from "express";
import { config } from "./config.js";
import * as store from "./db.js";
import { state, relink, runBackfill, listChats } from "./whatsapp.js";
import { buildDigest, localDateKey } from "./digest.js";
import { summary } from "./status.js";
import { openMedia, requestMedia, isQueued } from "./media.js";
import fs from "node:fs";
import { processPending } from "./processor.js";

export function startServer(getClient) {
  const app = express();
  app.use(express.json());

  app.get("/api/state", (req, res) => {
    res.json({
      status: state.status, qr: state.qrDataUrl, me: state.me, backfill: state.backfill, lastError: state.lastError, health: state.health, summary: summary(),
      today: localDateKey(), timezone: config.timezone, stats: store.stats(), items: store.allItems(),
    });
  });
  app.post("/api/items/:id/status", (req, res) => {
    const { status } = req.body || {};
    if (!["open", "done", "cancelled"].includes(status)) return res.status(400).json({ error: "bad status" });
    store.setStatus(Number(req.params.id), status, "from dashboard");
    res.json({ ok: true });
  });
  app.post("/api/items/:id", (req, res) => {
    const { title, when_iso, notes, type } = req.body || {};
    store.editItem(Number(req.params.id), { title, when_iso, notes, type });
    res.json({ ok: true });
  });
  app.post("/api/items", (req, res) => {
    const { type = "follow_up", title, who, when_iso, notes } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });
    const id = store.insertItem({ type, title, who, when_iso, all_day: when_iso && when_iso.length === 10, notes, confidence: "high", source_quote: "added manually" });
    res.json({ ok: true, id });
  });
  app.get("/api/items/:id/history", (req, res) => res.json(store.historyFor(Number(req.params.id))));
  app.get("/api/digest", (req, res) => res.type("text/plain").send(buildDigest()));
  app.post("/api/process", async (req, res) => {
    const { busy } = await import("./processor.js");
    if (busy || state.backfill) return res.json({ ok: true, touched: 0, note: "already working through messages" });
    res.json({ ok: true, started: true });
    // re-read recent chat history from WhatsApp (safety net), then extract anything pending
    runBackfill().then(() => processPending()).catch((e) => console.error("[process]", e.message));
  });
  app.post("/api/digest/send", async (req, res) => {
    const client = getClient?.();
    if (!client || state.status !== "ready") return res.status(409).json({ error: "WhatsApp not linked" });
    const { sendToSelf } = await import("./whatsapp.js");
    await sendToSelf(client, buildDigest());
    res.json({ ok: true });
  });

  app.get("/api/chats", async (req, res) => res.json(await listChats()));

  // Chat panel: recent messages of one chat (refreshed from WhatsApp when linked) and sending through the linked account.
  app.get("/api/chats/:chatId/messages", async (req, res) => {
    const chatId = req.params.chatId;
    const client = getClient?.();
    if (client && state.status === "ready" && !state.backfill) {
      try {
        const { toRecord, storeRecord } = await import("./whatsapp.js");
        const chat = await client.getChatById(chatId);
        const msgs = await chat.fetchMessages({ limit: 60 });
        for (const m of msgs) {
          const rec = toRecord(m, chat);
          if (rec) storeRecord(rec, 1); // history for display only; extraction already saw anything relevant
        }
      } catch (e) {
        console.warn(`[chat] could not refresh ${chatId}: ${String(e.message).slice(0, 120)}`);
      }
    }
    const messages = store.recentMessages(chatId, 80);
    for (const m of messages) if (m.media_type && isQueued(m.id)) m.media_status = "downloading";
    res.json({ chatId, messages });
  });
  // Diagnostic: what WhatsApp attaches to a raw message (used to locate preview thumbnails). Local only.
  app.get("/api/debug/msg/:id", async (req, res) => {
    try {
      const client = getClient?.();
      const msg = await client.getMessageById(req.params.id);
      const d = msg?._data || {};
      const out = {};
      for (const [k, v] of Object.entries(d)) out[k] = typeof v === "string" ? `${v.length} chars${v.length < 60 ? ": " + v : ""}` : Array.isArray(v) ? `array(${v.length})` : typeof v === "object" && v ? "object{" + Object.keys(v).slice(0, 8).join(",") + "}" : v;
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/api/media/:id/download", (req, res) => { requestMedia(req.params.id); res.json({ ok: true }); });
  app.get("/api/media/:id", (req, res) => {
    const row = store.getMedia(req.params.id);
    if (!row || !["ok", "thumb"].includes(row.status) || !fs.existsSync(row.path)) return res.status(404).end();
    res.type(row.mimetype || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(row.path);
  });
  app.post("/api/media/:id/open", async (req, res) => {
    try { await openMedia(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(404).json({ error: e.message }); }
  });
  app.post("/api/media/:id/retry", (req, res) => { requestMedia(req.params.id); res.json({ ok: true }); });
  app.post("/api/chats/:chatId/send", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    const client = getClient?.();
    if (!client || state.status !== "ready") return res.status(409).json({ error: "WhatsApp not linked" });
    try {
      await client.sendMessage(req.params.chatId, text);
      store.closeNoReply(req.params.chatId, "you followed up from the dashboard");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message).slice(0, 200) });
    }
  });

  // Disconnect the current phone and show a QR code for another one.
  app.post("/api/unlink", async (req, res) => {
    const clearData = !!req.body?.clearData;
    res.json({ ok: true });
    relink({ clearData }).catch((e) => console.error("[whatsapp] switch failed:", e.message));
  });
  app.post("/api/quit", (req, res) => {
    res.json({ ok: true });
    setTimeout(async () => { try { (await import("./index.js")).shutdown(); } catch { process.exit(0); } }, 300);
  });

  app.get("/", (req, res) => res.type("html").send(PAGE));
  app.listen(config.port, () => console.log(`[dashboard] http://localhost:${config.port}`));
  return app;
}

const PAGE = /* html */ `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>פגישות ומעקבים</title>
<style>
  :root{--ink:#17181c;--muted:#5f6470;--line:rgba(255,255,255,.65);--accent:#1b7a4a;--accent2:#2fb673;--warn:#b4471d;
    --glass:rgba(255,255,255,.52);--glass2:rgba(255,255,255,.34);--glass-strong:rgba(255,255,255,.72);
    --shadow:0 12px 32px rgba(25,35,70,.12),0 1px 0 rgba(255,255,255,.9) inset;--r:22px;--r2:16px}
  *{box-sizing:border-box}
  html{min-height:100%}
  body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Helvetica,Arial,sans-serif;color:var(--ink);min-height:100vh;
    background:#eaedf3;background-image:
      radial-gradient(900px 600px at 85% -10%,rgba(120,190,255,.55),transparent 60%),
      radial-gradient(700px 500px at -10% 30%,rgba(120,240,200,.45),transparent 60%),
      radial-gradient(800px 600px at 60% 110%,rgba(200,170,255,.45),transparent 60%),
      radial-gradient(500px 400px at 30% 80%,rgba(255,210,150,.35),transparent 60%);
    background-attachment:fixed}
  html.native body{background:transparent}
  .glass{background:var(--glass);-webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);border:1px solid var(--line);box-shadow:var(--shadow)}
  header{position:sticky;top:0;z-index:5;margin:14px 18px 0;padding:12px 18px;border-radius:var(--r);display:flex;gap:12px;align-items:center;flex-wrap:wrap;
    background:var(--glass);-webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);border:1px solid var(--line);box-shadow:var(--shadow)}
  h1{font-size:19px;margin:0;font-weight:700;letter-spacing:-.01em}
  .pill{font-size:12.5px;padding:4px 11px;border-radius:99px;background:rgba(27,122,74,.14);color:var(--accent);font-weight:600;border:1px solid rgba(27,122,74,.18)}
  .pill.off{background:rgba(180,71,29,.12);color:var(--warn);border-color:rgba(180,71,29,.2)}.pill.warn{background:rgba(209,154,0,.14);color:#6b4d00;border-color:rgba(209,154,0,.25)}
  .grow{flex:1}.muted{color:var(--muted)}
  button{font:inherit;border:1px solid var(--line);background:var(--glass-strong);color:var(--ink);border-radius:99px;padding:7px 14px;cursor:pointer;
    -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 2px 8px rgba(25,35,70,.08),0 1px 0 rgba(255,255,255,.9) inset;transition:transform .12s,background .15s}
  button:hover{background:rgba(255,255,255,.92)}button:active{transform:scale(.97)}
  button.primary{background:linear-gradient(135deg,var(--accent2),var(--accent));color:#fff;border-color:rgba(255,255,255,.35);box-shadow:0 6px 18px rgba(27,122,74,.28),0 1px 0 rgba(255,255,255,.35) inset}
  button.primary:hover{background:linear-gradient(135deg,#37c47e,#1f8a54)}
  main{max-width:900px;margin:0 auto;padding:18px 22px 60px}main.wide{max-width:1400px}
  .strip{margin:12px 18px 0;padding:11px 18px;border-radius:var(--r);display:flex;align-items:center;gap:10px;font-size:14px;cursor:pointer;
    -webkit-backdrop-filter:blur(22px) saturate(170%);backdrop-filter:blur(22px) saturate(170%);border:1px solid var(--line);box-shadow:var(--shadow)}
  .strip .dot{width:12px;height:12px;border-radius:99px;flex:none;box-shadow:0 0 0 4px rgba(255,255,255,.55)}
  .strip.ok{background:rgba(120,240,180,.28)}.strip.ok .dot{background:var(--accent)}
  .strip.warn{background:rgba(255,215,110,.32)}.strip.warn .dot{background:#d19a00}.strip.bad{background:rgba(255,150,120,.32)}.strip.bad .dot{background:var(--warn)}
  .strip b{font-weight:650}.strip .d{display:none;font-size:13px;color:var(--muted);margin-inline-start:8px}.strip.open .d{display:inline}
  .qr{border-radius:var(--r);padding:22px;text-align:center;margin:12px 0 22px;background:var(--glass);-webkit-backdrop-filter:blur(26px);backdrop-filter:blur(26px);border:1px solid var(--line);box-shadow:var(--shadow)}
  .qr img{width:260px;height:260px;border-radius:14px;background:#fff;padding:8px}
  .views{display:flex;gap:6px;margin:0 0 14px;padding:4px;border-radius:99px;width:max-content;background:var(--glass2);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid var(--line)}
  .views button{border:0;background:transparent;box-shadow:none;padding:6px 16px}.views button.on{background:var(--ink);color:#fff}
  nav{display:flex;gap:6px;margin:6px 0 16px;flex-wrap:wrap}nav button{padding:6px 12px}nav button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  .card{border-radius:var(--r2);padding:13px 15px;margin-bottom:10px;display:grid;grid-template-columns:34px 1fr auto;gap:10px;align-items:start;
    background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);border:1px solid var(--line);box-shadow:var(--shadow);transition:transform .15s}
  .card:hover{transform:translateY(-1px)}
  .card.done{opacity:.6}.ico{font-size:20px;line-height:1.2}.title{font-weight:650;cursor:pointer}.title:hover{text-decoration:underline}.when{font-weight:650;color:var(--accent)}.when.overdue{color:var(--warn)}
  .meta{font-size:13px;color:var(--muted);margin-top:2px}.quote{font-size:13px;color:var(--muted);margin-top:6px;border-right:2px solid rgba(0,0,0,.12);padding-right:8px;white-space:pre-wrap}
  .actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.actions button{padding:4px 11px;font-size:13px}
  .empty{color:var(--muted);padding:30px;text-align:center}
  .day{font-size:12.5px;font-weight:700;letter-spacing:.02em;color:var(--muted);margin:18px 6px 8px}
  .add{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
  .add input,.add select,.clist input,.compose textarea{font:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:14px;background:var(--glass-strong);color:var(--ink);outline:none;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
  .add input:focus,.compose textarea:focus,.clist input:focus{border-color:rgba(27,122,74,.5);box-shadow:0 0 0 3px rgba(27,122,74,.15)}
  .add input.t{flex:1;min-width:200px}
  .stat{font-size:13px;color:var(--muted)}
  .alert{border-radius:var(--r2);padding:12px 16px;margin:0 0 16px;font-weight:600;background:rgba(255,150,120,.35);color:#7a2e10;border:1px solid rgba(255,255,255,.6);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
  .alert.soft{background:rgba(255,215,110,.35);color:#6b4d00;font-weight:500}
  #chatsview{display:none}#chatsview.on{display:flex;gap:14px;align-items:stretch;height:calc(100vh - 230px);min-height:420px}
  .clist{width:340px;flex:none;border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden;background:var(--glass);-webkit-backdrop-filter:blur(26px) saturate(160%);backdrop-filter:blur(26px) saturate(160%);border:1px solid var(--line);box-shadow:var(--shadow)}
  .clist input{margin:10px;border-radius:12px}
  .cl{flex:1;overflow:auto}.ci{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.5);cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:2px 8px;transition:background .12s}
  .ci:hover{background:rgba(255,255,255,.45)}.ci.on{background:rgba(27,122,74,.14)}.ci b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ci .t{font-size:11.5px;color:var(--muted)}
  .ci .p{grid-column:1/3;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ci .u{background:var(--accent);color:#fff;border-radius:99px;font-size:11px;padding:1px 7px;justify-self:end}
  .cempty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);border-radius:var(--r);background:var(--glass2);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border:1px solid var(--line)}
  #panel{position:fixed;top:14px;left:14px;bottom:14px;width:min(460px,calc(100vw - 28px));border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden;transform:translateX(-110%);transition:transform .22s;z-index:20;
    background:var(--glass);-webkit-backdrop-filter:blur(30px) saturate(170%);backdrop-filter:blur(30px) saturate(170%);border:1px solid var(--line);box-shadow:0 20px 60px rgba(25,35,70,.22),0 1px 0 rgba(255,255,255,.9) inset}
  #panel.open{transform:none}
  body.chats #panel{position:static;transform:none;width:auto;flex:1;min-width:0;box-shadow:var(--shadow)}
  body.chats #panel .ph button{display:none}
  .ph{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.5);display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.25)}.ph b{flex:1;font-size:15px}
  .msgs{flex:1;overflow:auto;padding:14px 12px;display:flex;flex-direction:column;gap:6px;background:rgba(255,255,255,.12)}
  .b{max-width:82%;padding:8px 11px;border-radius:16px;font-size:14px;white-space:pre-wrap;word-break:break-word;align-self:flex-start;
    background:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.7);box-shadow:0 2px 8px rgba(25,35,70,.08);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .b.me{background:rgba(205,248,214,.82);align-self:flex-end}.b .t{display:block;font-size:11px;color:var(--muted);margin-top:3px;text-align:left}
  .b.hl{outline:2px solid var(--accent)}
  .compose{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.25)}.compose textarea{flex:1;resize:none;height:44px}
  .sent{font-size:12px;color:var(--accent);padding:0 14px 8px}
  .mimg{max-width:260px;max-height:280px;border-radius:12px;display:block;cursor:zoom-in;margin-bottom:4px}
  .maud{width:260px;display:block;margin-bottom:4px}.mvid{max-width:260px;border-radius:12px;display:block;margin-bottom:4px}
  .mfile{display:inline-flex;gap:6px;align-items:center;font-size:13px;margin-bottom:4px}.mnote{font-size:12px;color:var(--muted);display:block;margin-bottom:4px}
  .mph{position:relative;width:220px;height:150px;border-radius:12px;overflow:hidden;background:rgba(120,130,150,.25);display:flex;align-items:center;justify-content:center;margin-bottom:4px}
  .mph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(8px);transform:scale(1.1)}
  .mph.small{width:220px;height:54px}
  .mph .dl{position:relative;z-index:1;background:rgba(255,255,255,.85);border:1px solid var(--line);border-radius:99px;padding:6px 12px;font-size:13px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.15);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
  .mph .dl:hover{background:#fff}.mph .lbl{position:absolute;bottom:4px;inset-inline:8px;font-size:11px;color:#333;background:rgba(255,255,255,.7);border-radius:8px;padding:1px 6px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media (prefers-color-scheme: dark){
    :root{--ink:#f1f2f6;--muted:#a7acb8;--line:rgba(255,255,255,.14);--glass:rgba(30,34,44,.55);--glass2:rgba(30,34,44,.4);--glass-strong:rgba(50,55,68,.7);--accent:#3ed48c;--accent2:#1b7a4a;--warn:#ff9a7a;--shadow:0 12px 32px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.08) inset}
    body{background:#171a22;background-image:radial-gradient(900px 600px at 85% -10%,rgba(60,120,220,.45),transparent 60%),radial-gradient(700px 500px at -10% 30%,rgba(40,170,130,.35),transparent 60%),radial-gradient(800px 600px at 60% 110%,rgba(140,90,220,.35),transparent 60%)}
    .pill{background:rgba(62,212,140,.16)}.views button.on,nav button.on{background:#fff;color:#111;border-color:#fff}
    .b{background:rgba(60,66,80,.8);border-color:rgba(255,255,255,.1)}.b.me{background:rgba(35,110,70,.7)}.mph .lbl,.mph .dl{color:#111}
    .strip.ok{background:rgba(40,170,110,.25)}.strip.warn{background:rgba(200,150,30,.25)}.strip.bad{background:rgba(200,80,50,.3)}
    .alert{background:rgba(200,80,50,.3);color:#ffd9cc}.alert.soft{background:rgba(200,150,30,.28);color:#ffe9b0}.qr img{background:#fff}
  }
</style></head><body>
<header><h1>פגישות ומעקבים</h1><span id="status" class="pill">…</span><span id="bf" class="stat"></span><span class="grow"></span>
<button id="checkbtn" onclick="checkNow()">לבדוק הודעות חדשות עכשיו</button><button onclick="openDigest()">סדר היום</button><button id="switchbtn" onclick="switchPhone()">החלפת טלפון</button><button onclick="quitApp()" title="לעצור את התוכנה">יציאה</button></header>
<div id="strip" class="strip" onclick="this.classList.toggle('open')"><span class="dot"></span><b id="stext">בודק…</b><span class="d" id="sdetails"></span><span class="grow"></span><span class="stat">לחיצה לפרטים</span></div>
<main id="main">
<div class="views"><button id="v-tasks" class="on" onclick="setView('tasks')">משימות</button><button id="v-chats" onclick="setView('chats')">צ'אטים</button></div>
<div id="alerts"></div>
<div id="qr" class="qr" style="display:none"><div style="margin-bottom:10px">בטלפון שרוצים לעקוב אחריו: <b>וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר</b>, ואז לסרוק:</div><img id="qrimg" alt="קוד QR"></div>
<form class="add" onsubmit="return addItem(event)"><select id="ntype"><option value="follow_up">מעקב</option><option value="meeting">פגישה</option><option value="call">שיחה</option></select>
<input class="t" id="ntitle" placeholder="להוסיף משהו בעצמך, למשל: להתקשר לבנק בקשר לכרטיס"><input id="nwhen" type="datetime-local"><button class="primary">הוספה</button></form>
<div id="tasksview">
<nav id="tabs"></nav>
<div id="list"></div>
</div>
<div id="chatsview"><div class="clist"><input id="csearch" placeholder="חיפוש צ'אט…" oninput="renderChats()"><div class="cl" id="clist"></div></div><div id="cslot" class="cempty">בוחרים צ'אט מהרשימה</div></div>
</main>
<div id="panel"><div class="ph"><b id="pname"></b><span id="pstatus" class="stat"></span><button onclick="closeChat()">סגירה</button></div>
<div class="msgs" id="pmsgs"></div><div class="sent" id="psent"></div>
<div class="compose"><textarea id="ptext" placeholder="לכתוב הודעה… (Enter לשליחה, Shift+Enter לשורה חדשה)"></textarea><button class="primary" onclick="sendMsg()">שליחה</button></div></div>
<script>
const ICON={meeting:'📅',call:'📞',follow_up:'✅'};
const L='he-IL';
let S=null, tab=localStorage.getItem('tab')||'upcoming';
const key=it=>(it.when_iso||'').slice(0,10);
function fmtWhen(it){ if(!it.when_iso) return it.when_text||'בלי תאריך עדיין'; const [d,t]=it.when_iso.split('T'); const day=new Date(d+'T12:00:00').toLocaleDateString(L,{weekday:'short',day:'numeric',month:'short'}); return t&&!it.all_day?day+' · '+t:day; }
function dayLabel(d,today){ if(!d) return 'בלי תאריך'; if(d===today) return 'היום'; const t=new Date(today+'T12:00:00'), x=new Date(d+'T12:00:00'); const diff=Math.round((x-t)/864e5); if(diff===1) return 'מחר'; if(diff===-1) return 'אתמול'; return x.toLocaleDateString(L,{weekday:'long',day:'numeric',month:'long'}); }
function groups(items){ const today=S.today, open=items.filter(i=>i.status==='open'); return {
  today: open.filter(i=>key(i)===today),
  upcoming: open.filter(i=>key(i)>=today),
  overdue: open.filter(i=>key(i)&&key(i)<today),
  followups: open.filter(i=>i.type==='follow_up'),
  undated: open.filter(i=>!key(i)),
  all: open,
  done: items.filter(i=>i.status!=='open'),
};}
const STATUS_HE={done:'בוצע',cancelled:'בוטל'};
function render(){
  const g=groups(S.items);
  const tabs=[['today','היום',g.today.length],['upcoming','קרוב',g.upcoming.length],['overdue','באיחור',g.overdue.length],['followups','מעקבים',g.followups.length],['undated','בלי תאריך',g.undated.length],['all','כל הפתוחים',g.all.length],['done','בוצע / בוטל',g.done.length]];
  document.getElementById('tabs').innerHTML=tabs.map(([k,l,n])=>'<button class="'+(tab===k?'on':'')+'" onclick="setTab(\\''+k+'\\')">'+l+' <span class="muted">'+n+'</span></button>').join('');
  const items=g[tab]; const list=document.getElementById('list');
  if(!items.length){ list.innerHTML='<div class="empty">אין כאן כלום.</div>'; return; }
  let html='', last=null;
  for(const it of items){ const d=key(it); if(tab!=='done'&&d!==last){ html+='<div class="day">'+dayLabel(d,S.today)+'</div>'; last=d; }
    const over=it.status==='open'&&d&&d<S.today;
    html+='<div class="card '+(it.status!=='open'?'done':'')+'"><div class="ico">'+ICON[it.type]+'</div><div>'
      +'<div><span class="when '+(over?'overdue':'')+'">'+esc(fmtWhen(it))+'</span> &nbsp;<span class="title" title="לפתוח את הצ\\'אט" onclick="openChat('+it.id+')">'+esc(it.title)+'</span></div>'
      +'<div class="meta">'+[it.who, it.chat_name&&it.chat_name!==it.who?'צ\\'אט: '+it.chat_name:null, it.location, STATUS_HE[it.status]||null, it.confidence==='medium'?'ביטחון בינוני':it.confidence==='low'?'ביטחון נמוך':null].filter(Boolean).map(esc).join(' · ')+'</div>'
      +(it.notes?'<div class="meta">'+esc(it.notes)+'</div>':'')
      +(it.source_quote?'<div class="quote">„'+esc(it.source_quote)+'”</div>':'')
      +'</div><div class="actions">'
      +(it.status==='open'?'<button onclick="setStatus('+it.id+',\\'done\\')">בוצע</button><button onclick="setStatus('+it.id+',\\'cancelled\\')">ביטול</button><button onclick="editWhen('+it.id+')">תאריך</button>':'<button onclick="setStatus('+it.id+',\\'open\\')">לפתוח מחדש</button>')
      +'</div></div>'; }
  list.innerHTML=html;
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function setTab(t){tab=t;localStorage.setItem('tab',t);render()}
async function load(){ try{ S=await (await fetch('/api/state')).json(); }catch{ return; }
  const st=document.getElementById('status'); const map={starting:'מתחיל…',qr:'ממתין לסריקת QR',authenticating:'מתחבר…',ready:'מחובר'+(S.me?': '+S.me:''),disconnected:'מנותק',switching:'מנתק את הטלפון…'};
  document.getElementById('switchbtn').textContent=S.status==='qr'?'ביטול / לנסות שוב':'החלפת טלפון';
  st.textContent=map[S.status]||S.status; st.className='pill '+(S.status==='ready'?'':'off');
  if(S.summary){ const sp=document.getElementById('strip'); sp.className='strip '+S.summary.level+(sp.classList.contains('open')?' open':''); document.getElementById('stext').textContent=S.summary.text; document.getElementById('sdetails').textContent=S.summary.details.join(' · '); }
  document.getElementById('bf').textContent=S.backfill?('קורא צ\\'אטים '+S.backfill.done+'/'+S.backfill.total+(S.backfill.chat?' – '+S.backfill.chat:'')):(S.stats.pending?S.stats.pending+' הודעות ממתינות לקריאה':'');
  document.getElementById('qr').style.display=S.qr?'block':'none'; if(S.qr) document.getElementById('qrimg').src=S.qr;
  const al=[]; const h=S.health||{};
  if(h.whatsapp) al.push('<div class="alert">⚠️ '+esc(h.whatsapp)+'</div>');
  if(S.status==='disconnected') al.push('<div class="alert">⚠️ החיבור לוואטסאפ נותק'+(S.lastError?' ('+esc(S.lastError)+')':'')+'. התוכנה מנסה להתחבר מחדש; אם זה לא עוזר, לוחצים "החלפת טלפון" וסורקים שוב.</div>');
  if(h.gemini) al.push('<div class="alert soft">ℹ️ '+esc(h.gemini)+'</div>');
  document.getElementById('alerts').innerHTML=al.join('');
  render(); }
async function run(url,body){ await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); load(); }
function setStatus(id,status){ run('/api/items/'+id+'/status',{status}); }
let checking=false;
async function checkNow(){ if(checking) return; const b=document.getElementById('checkbtn'); checking=true; b.disabled=true; b.textContent='בודק…';
  try{ await fetch('/api/process',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); }catch{}
  const t0=Date.now(); const tick=setInterval(async()=>{ await load(); const busy=S&&(S.backfill||S.stats.pending>0); b.textContent=busy?('בודק… '+(S.backfill?S.backfill.done+'/'+S.backfill.total:S.stats.pending+' ממתינות')):'הבדיקה הושלמה ✓'; if(!busy||Date.now()-t0>600000){ clearInterval(tick); setTimeout(()=>{b.textContent='לבדוק הודעות חדשות עכשיו'; b.disabled=false; checking=false;},2500); } },3000); }
function editWhen(id){ const it=S.items.find(i=>i.id===id); const v=prompt('תאריך ושעה (YYYY-MM-DD או YYYY-MM-DD HH:MM):',(it.when_iso||'').replace('T',' ')); if(v==null) return; run('/api/items/'+id,{when_iso:v.trim().replace(' ','T')||null}); }
function addItem(e){ e.preventDefault(); const title=document.getElementById('ntitle').value.trim(); if(!title) return false; run('/api/items',{type:document.getElementById('ntype').value,title,when_iso:document.getElementById('nwhen').value||null}); document.getElementById('ntitle').value=''; document.getElementById('nwhen').value=''; return false; }
async function switchPhone(){
  if(S.status==='ready'&&!confirm('לנתק את '+(S.me||'הטלפון הזה')+' מהמעקב?\\n\\nהמכשיר המקושר יוסר מהטלפון ויופיע כאן קוד QR חדש.')) return;
  const clearData=confirm('למחוק גם את הפגישות, המעקבים וההודעות שהגיעו מהטלפון הנוכחי?\\n\\nאישור = למחוק (התחלה נקייה לטלפון החדש)\\nביטול = לשמור אותם');
  await run('/api/unlink',{clearData}); setTab('upcoming'); }
async function quitApp(){ if(!confirm('לעצור את התוכנה? היא תפסיק לקרוא הודעות עד שתפתחו אותה שוב.')) return; await fetch('/api/quit',{method:'POST'}); document.getElementById('status').textContent='נעצר'; document.getElementById('status').className='pill off'; }
async function openDigest(){ const t=await (await fetch('/api/digest')).text(); alert(t.replace(/\\*/g,'')); }
let cur=null, ptimer=null, view=localStorage.getItem('view')||'tasks', chats=[], ctimer=null;
function setView(v){ view=v; localStorage.setItem('view',v); document.body.classList.toggle('chats',v==='chats');
  document.getElementById('v-tasks').classList.toggle('on',v==='tasks'); document.getElementById('v-chats').classList.toggle('on',v==='chats');
  document.getElementById('tasksview').style.display=v==='tasks'?'':'none'; document.querySelector('.add').style.display=v==='tasks'?'':'none';
  document.getElementById('chatsview').classList.toggle('on',v==='chats'); document.getElementById('main').classList.toggle('wide',v==='chats');
  const panel=document.getElementById('panel');
  if(v==='chats'){ if(cur){ const slot=document.getElementById('cslot'); if(slot) slot.replaceWith(panel); panel.classList.add('open'); } else panel.classList.remove('open'); loadChats(); clearInterval(ctimer); ctimer=setInterval(loadChats,20000); }
  else { clearInterval(ctimer); if(panel.parentElement!==document.body){ const slot=document.createElement('div'); slot.id='cslot'; slot.className='cempty'; slot.textContent='בוחרים צ\\'אט מהרשימה'; panel.replaceWith(slot); document.body.appendChild(panel); } closeChat(); } }
async function loadChats(){ try{ chats=await (await fetch('/api/chats')).json(); }catch{ return; } if(cur&&cur.name===cur.chatId){ const c=chats.find(x=>x.id===cur.chatId); if(c){ cur.name=c.name; document.getElementById('pname').textContent=c.name; } } renderChats(); }
function renderChats(){ const q=(document.getElementById('csearch').value||'').trim().toLowerCase(); const list=chats.filter(c=>!q||(c.name||'').toLowerCase().includes(q)||(c.last_body||'').toLowerCase().includes(q));
  document.getElementById('clist').innerHTML=list.map(c=>'<div class="ci '+(cur&&cur.chatId===c.id?'on':'')+'" onclick="openChatById(\\''+esc(c.id)+'\\')"><b>'+esc(c.name||c.id)+'</b><span class="t">'+(c.timestamp?fmtChatTime(c.timestamp):'')+'</span><span class="p">'+(c.last_from_me?'את: ':'')+esc(c.last_body||'')+'</span>'+(c.unread?'<span class="u">'+c.unread+'</span>':'')+'</div>').join('')||'<div class="stat" style="padding:14px">אין צ\\'אטים להצגה.</div>'; }
function fmtChatTime(ts){ const d=new Date(ts*1000), now=new Date(); return d.toDateString()===now.toDateString()?d.toLocaleTimeString(L,{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString(L,{day:'numeric',month:'short'}); }
async function openChatById(chatId){ const c=chats.find(x=>x.id===chatId); await showChat({chatId, name:c?c.name:chatId, msgId:null}); renderChats(); }
async function openChat(itemId){ const it=S.items.find(i=>i.id===itemId); if(!it||!it.chat_id){ alert('הפריט הזה לא מקושר לצ\\'אט.'); return; }
  await showChat({chatId:it.chat_id,name:it.chat_name||it.who||it.chat_id,msgId:it.source_msg_id}); }
async function showChat(c){ cur=c; const panel=document.getElementById('panel');
  if(view==='chats'&&panel.parentElement===document.body){ const slot=document.getElementById('cslot'); if(slot) slot.replaceWith(panel); }
  document.getElementById('pname').textContent=cur.name; document.getElementById('pmsgs').innerHTML='<div class="stat">טוען…</div>';
  panel.classList.add('open'); await loadChat(true); clearInterval(ptimer); ptimer=setInterval(()=>loadChat(false),8000); document.getElementById('ptext').focus(); }
function closeChat(){ document.getElementById('panel').classList.remove('open'); clearInterval(ptimer); cur=null; }
setView(view);
async function loadChat(scroll){ if(!cur) return; const id=cur.chatId; let d; try{ d=await (await fetch('/api/chats/'+encodeURIComponent(id)+'/messages')).json(); }catch{ return; } if(!cur||cur.chatId!==id) return;
  const box=document.getElementById('pmsgs'); const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40;
  // never rebuild the list while a voice note or video is playing (it would restart it), and only rebuild when something changed
  if([...box.querySelectorAll('audio,video')].some(el=>!el.paused&&!el.ended)) return;
  const sig=d.messages.map(m=>m.id+':'+(m.media_status||'')).join('|');
  if(!scroll&&sig===box.dataset.sig) return;
  box.dataset.sig=sig;
  box.innerHTML=d.messages.map(m=>'<div class="b '+(m.from_me?'me':'')+(m.id===cur.msgId?' hl':'')+'">'+mediaHtml(m)+esc(bodyText(m))+'<span class="t">'+(m.from_me?'':esc(m.sender||'')+' · ')+new Date(m.ts*1000).toLocaleString(L,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+'</span></div>').join('')||'<div class="stat">עדיין אין הודעות שמורות לצ\\'אט הזה.</div>';
  if(scroll||atBottom) box.scrollTop=box.scrollHeight; }
function fmtSize(n){ if(!n) return ''; return n>1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB'; }
function bodyText(m){ if(m.media_type&&m.media_type!=='sticker'&&m.body&&m.body.startsWith('[')){ const i=m.body.indexOf(']'); return i>0?m.body.slice(i+1).trim():''; } return m.body||''; }
function mediaHtml(m){ if(!m.media_type||m.media_type==='sticker') return ''; const url='/api/media/'+encodeURIComponent(m.id); const id=esc(m.id);
  if(m.media_status==='ok'){ const mime=m.media_mime||'';
    if(mime.startsWith('image/')) return '<img class="mimg" src="'+url+'" onclick="openMedia(\\''+id+'\\')" title="לפתיחה בגודל מלא">';
    if(mime.startsWith('audio/')) return '<audio class="maud" controls preload="metadata" src="'+url+'"></audio>';
    if(mime.startsWith('video/')) return '<video class="mvid" controls preload="metadata" src="'+url+'"></video>';
    return '<button class="mfile" onclick="openMedia(\\''+id+'\\')">📎 '+esc(m.media_filename||'קובץ')+' <span class="muted">'+fmtSize(m.media_size)+'</span></button>'; }
  const ICONS={image:'🖼️',video:'🎬',ptt:'🎤',audio:'🎵',document:'📎'}; const LBL={image:'תמונה',video:'סרטון',ptt:'הודעה קולית',audio:'קובץ שמע',document:'קובץ'};
  const small=!(m.media_type==='image'||m.media_type==='video'); const bg=m.media_status==='thumb'?'<img src="'+url+'" alt="">':'';
  const name=m.media_type==='document'&&m.body&&m.body.startsWith('[קובץ:')?m.body.slice(6,m.body.indexOf(']')).trim():LBL[m.media_type]||'קובץ';
  let btn;
  if(m.media_status==='downloading') btn='<span class="dl">⏳ מוריד…</span>';
  else if(m.media_status==='too_large') btn='<span class="dl">קובץ גדול מדי ('+fmtSize(m.media_size)+')</span>';
  else btn='<button class="dl" onclick="downloadMedia(\\''+id+'\\')">⬇️ '+(m.media_status==='failed'?'לנסות שוב':'הורדה')+'</button>';
  const note=m.media_status==='failed'?'<span class="lbl">'+esc(m.media_error||'לא הצלחתי להוריד')+'</span>':(small?'':'<span class="lbl">'+ICONS[m.media_type]+' '+esc(name)+'</span>');
  return '<div class="mph'+(small?' small':'')+'">'+bg+(small?'<span style="position:relative;z-index:1;margin-inline-end:8px">'+ICONS[m.media_type]+' '+esc(name)+'</span>':'')+btn+note+'</div>'; }
async function downloadMedia(id){ await fetch('/api/media/'+encodeURIComponent(id)+'/download',{method:'POST'}); setTimeout(()=>loadChat(false),1500); setTimeout(()=>loadChat(false),6000); }
async function openMedia(id){ const r=await fetch('/api/media/'+encodeURIComponent(id)+'/open',{method:'POST'}); if(!r.ok) alert('הקובץ לא זמין'); }
async function retryMedia(id){ await fetch('/api/media/'+encodeURIComponent(id)+'/retry',{method:'POST'}); setTimeout(()=>loadChat(false),3000); }
async function sendMsg(){ if(!cur) return; const ta=document.getElementById('ptext'); const text=ta.value.trim(); if(!text) return; ta.disabled=true;
  const r=await fetch('/api/chats/'+encodeURIComponent(cur.chatId)+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})}); const j=await r.json(); ta.disabled=false;
  if(!r.ok){ alert('השליחה נכשלה: '+(j.error||r.status)); return; } ta.value=''; document.getElementById('psent').textContent='נשלח ✓'; setTimeout(()=>document.getElementById('psent').textContent='',2500); setTimeout(()=>{loadChat(true);load();},1500); }
document.getElementById('ptext').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } });
load(); setInterval(load,10000);
</script></body></html>`;
