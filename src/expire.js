import { config } from "./config.js";
import * as store from "./db.js";
import { notify } from "./notify.js";

/**
 * Meetings and calls whose time passed more than AUTO_CLOSE_PAST_HOURS ago:
 *  - a CONFIRMED one is closed as done (it happened; the "nobody answered" check still covers any loose end)
 *  - a PROPOSED time that nobody confirmed is NOT closed: it turns into a follow-up to get an answer /
 *    reschedule, dated today, so it stays on the list until you deal with it.
 * Follow-ups are never closed automatically.
 */
export function closePastAppointments(now = Date.now()) {
  if (!config.autoClosePastHours) return 0;
  const limit = new Date(now - config.autoClosePastHours * 3600_000);
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: config.timezone });
  let n = 0;
  for (const it of store.openItems()) {
    if (!it.when_iso || it.type === "follow_up") continue;
    const when = it.when_iso.length === 10 ? new Date(it.when_iso + "T23:59:00") : new Date(it.when_iso);
    if (Number.isNaN(when.getTime()) || when > limit) continue;
    const tentative = it.confidence === "low" || /מוצע, לא אושר/.test(it.notes || "");
    if (tentative) {
      const who = it.who || it.chat_name || "";
      const title = `לקבל תשובה${who ? ` מ${who}` : ""} על ${it.title}`;
      store.editItem(it.id, { type: "follow_up", title, when_iso: today, notes: `${it.notes || ""}\nהמועד המוצע (${it.when_text || it.when_iso}) עבר בלי תשובה - צריך לתאם מחדש.`.trim() });
      store.db.prepare("UPDATE items SET all_day = 1, when_text = ? WHERE id = ?").run("המועד המוצע עבר בלי תשובה", it.id);
      console.log(`  ~ [follow_up] ${title}`);
      notify("מעקב פגישות", title);
    } else {
      store.setStatus(it.id, "done", "המועד עבר (נסגר אוטומטית)");
      console.log(`  x [done] ${it.title} - המועד עבר`);
    }
    n++;
  }
  return n;
}
