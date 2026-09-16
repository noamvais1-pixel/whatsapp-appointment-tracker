import { extractItems } from "./extract.js";
import * as store from "./db.js";
import { notify } from "./notify.js";
import { reportGemini } from "./whatsapp.js";

const BATCH = 80;
const TYPE_HE = { meeting: "פגישה", call: "שיחה", follow_up: "מעקב" };

// One extraction at a time, ever. Prevents duplicate items and keeps within API rate limits.
let queue = Promise.resolve();
export let busy = false;
function serialized(fn) {
  const run = queue.then(async () => {
    busy = true;
    try { return await fn(); } finally { busy = false; }
  });
  queue = run.catch(() => {});
  return run;
}

/** Process every unprocessed message for one chat, in batches. Returns count of items touched. */
export function processChat(chatId, chatName) {
  return serialized(() => processChatNow(chatId, chatName));
}

async function processChatNow(chatId, chatName) {
  let touched = 0;
  for (;;) {
    const pending = store.unprocessedInChat(chatId);
    if (!pending.length) break;
    const batch = pending.slice(0, BATCH);
    const context = store.contextBefore(chatId, batch[0].ts, 25);
    const existing = store.openItemsForChat(chatId);
    let items = [];
    try {
      items = await extractItems({ chatName, contextMsgs: context, newMsgs: batch, existingItems: existing });
      reportGemini(true);
    } catch (e) {
      console.error(`[processor] extraction failed for "${chatName}": ${String(e.message).slice(0, 160)}`);
      reportGemini(false, e);
      throw e; // leave messages unprocessed so we retry later
    }
    for (const it of items) {
      touched += applyItem(it, chatId, chatName, existing);
    }
    store.markProcessed(batch.map((m) => m.id));
    if (batch.length < BATCH) break;
  }
  return touched;
}

function applyItem(it, chatId, chatName, existing) {
  const base = {
    type: it.type, title: it.title, who: it.who, chat_id: chatId, chat_name: chatName,
    when_iso: it.when_iso, all_day: it.all_day, when_text: it.when_text, location: it.location,
    notes: it.notes, confidence: it.confidence, source_msg_id: it.source_msg_id, source_quote: it.source_quote,
  };
  const target = it.existing_id != null ? store.getItem(it.existing_id) : null;
  const validTarget = target && target.chat_id === chatId;

  if (it.action === "create" || !validTarget) {
    if (it.action !== "create") return 0; // update/cancel/done pointing at nothing we know
    const id = store.insertItem(base);
    console.log(`  + [${it.type}] ${it.title}${it.when_iso ? " @ " + it.when_iso : ""}  (${chatName})`);
    notify(`${TYPE_HE[it.type]} חדש/ה: ${it.title}`, `${it.when_text || it.when_iso || "בלי תאריך"} · ${chatName}`);
    return 1;
  }
  if (it.action === "update") {
    store.updateItem(target.id, { ...base, notes: it.notes ?? target.notes, location: it.location ?? target.location });
    console.log(`  ~ [${it.type}] ${it.title} -> ${it.when_iso ?? "no date"}  (${chatName})`);
    notify(`עודכן: ${it.title}`, `${it.when_text || it.when_iso || "בלי תאריך"} · ${chatName}`);
    return 1;
  }
  if (it.action === "cancel" || it.action === "done") {
    store.setStatus(target.id, it.action === "cancel" ? "cancelled" : "done", it.source_quote);
    console.log(`  x [${it.action}] ${target.title}  (${chatName})`);
    notify(`${it.action === "cancel" ? "בוטל" : "בוצע"}: ${target.title}`, chatName);
    return 1;
  }
  return 0;
}

/** Process all chats that have pending messages. */
export async function processPending({ minAgeSec = 0 } = {}) {
  const chats = store.unprocessedChats();
  const nowSec = Math.floor(Date.now() / 1000);
  let total = 0;
  for (const c of chats) {
    const newest = store.unprocessedInChat(c.chat_id).at(-1)?.ts ?? 0;
    if (nowSec - newest < minAgeSec) continue; // wait for the conversation to settle
    try {
      total += await processChat(c.chat_id, c.chat_name);
    } catch {
      // logged already; keep going with other chats
    }
  }
  return total;
}
