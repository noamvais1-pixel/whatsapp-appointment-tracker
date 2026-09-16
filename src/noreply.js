import { config } from "./config.js";
import * as store from "./db.js";
import { notify } from "./notify.js";
import { localDateKey } from "./digest.js";
import { judgeFollowUp } from "./extract.js";
import { state } from "./whatsapp.js";

// Obvious non-questions we never bother Gemini with ("thanks", "ok", an emoji...).
const CLOSERS = new Set([
  "תודה", "תודה רבה", "תודה רבה לך", "בסדר", "בסדר גמור", "סבבה", "אוקי", "אוקיי", "או קיי", "מעולה", "יופי", "נהדר", "מצוין", "בבקשה",
  "לילה טוב", "שבת שלום", "שבוע טוב", "בהצלחה", "סגור", "מושלם", "ביי", "להתראות",
  "ok", "okay", "k", "thanks", "thank you", "thanks a lot", "thank you so much", "thx", "ty", "great", "perfect", "bye", "good night",
  "sure", "no problem", "np", "got it", "noted", "done", "cool", "nice", "amazing", "welcome", "you're welcome",
]);

function obviouslyClosed(body) {
  const stripped = body.replace(/[\p{Extended_Pictographic}\p{P}\p{S}\s]+$/gu, "").replace(/^[\p{Extended_Pictographic}\p{P}\p{S}\s]+/gu, "").trim().toLowerCase();
  return !stripped || CLOSERS.has(stripped) || body.startsWith("[");
}

let running = false;

/**
 * For every chat where Me wrote last and nobody answered for NO_REPLY_HOURS, ask Gemini (with the recent
 * conversation) whether a follow-up is actually needed. Creates a reminder only when it says yes.
 * Reminders close themselves when the other side replies.
 */
export async function checkNoReplies(now = Date.now()) {
  if (!config.noReplyHours || running) return 0;
  running = true;
  state.health.lastNoReplyCheckAt = Date.now();
  let created = 0;
  try {
    const cutoff = Math.floor(now / 1000) - config.noReplyHours * 3600;
    for (const m of store.lastMessagePerChat()) {
      if (!m.from_me) { store.closeNoReply(m.chat_id); continue; }
      if (m.ts > cutoff) continue;
      if (store.noReplyItemForMsg(m.id) || store.getMeta(`noreply:${m.id}`)) continue; // already decided for this message
      if (obviouslyClosed(m.body)) { store.setMeta(`noreply:${m.id}`, "no:closer"); continue; }

      const msgs = store.recentMessages(m.chat_id, 20);
      let verdict = null;
      try {
        verdict = await judgeFollowUp({ chatName: m.chat_name, msgs, existingItems: store.openItemsForChat(m.chat_id) });
      } catch (e) {
        console.warn(`[noreply] could not judge "${m.chat_name}": ${String(e.message).slice(0, 120)}`);
        continue; // try again next round
      }
      if (!verdict) continue;
      if (!verdict.needs_follow_up) {
        store.setMeta(`noreply:${m.id}`, `no:${verdict.reason}`);
        console.log(`  · no follow-up needed: ${m.chat_name} (${verdict.reason})`);
        continue;
      }
      const sent = new Date(m.ts * 1000).toLocaleString("he-IL", { timeZone: config.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      store.insertItem({
        type: "follow_up",
        kind: "noreply",
        title: verdict.title || `${m.chat_name} לא ענה/תה - לעשות מעקב`,
        who: m.chat_name,
        chat_id: m.chat_id,
        chat_name: m.chat_name,
        when_iso: localDateKey(new Date(now)),
        all_day: true,
        when_text: `בלי תשובה מאז ${sent}`,
        notes: verdict.reason,
        confidence: verdict.urgency === "low" ? "medium" : "high",
        source_msg_id: m.id,
        source_quote: m.body.slice(0, 300),
      });
      store.setMeta(`noreply:${m.id}`, "yes");
      console.log(`  + [follow_up] ${verdict.title}  (${m.chat_name}, unanswered since ${sent})`);
      notify(`אין תשובה מ-${m.chat_name}`, verdict.title);
      created++;
    }
  } finally {
    running = false;
  }
  return created;
}
