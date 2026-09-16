import { state } from "./whatsapp.js";
import * as store from "./db.js";

const MIN = 60_000;
const ago = (t) => (t ? Math.round((Date.now() - t) / MIN) : null);
const agoText = (t) => {
  const m = ago(t);
  if (m === null) return "עדיין לא";
  if (m < 1) return "לפני פחות מדקה";
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  return h < 48 ? `לפני ${h} שע׳` : `לפני ${Math.floor(h / 24)} ימים`;
};

/**
 * One honest answer to "is it working?".
 * level: ok | warn | bad. text: what to show. details: the evidence.
 */
export function summary() {
  const h = state.health;
  const stats = store.stats();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const last = store.lastMessage();
  const lastText = last
    ? `${agoText(last.ts * 1000)} (${last.from_me ? "את אל" : "מ"}${last.chat_name})`
    : "עדיין לא";
  const details = [
    `וואטסאפ: ${state.status === "ready" ? "מחובר" : "לא מחובר"}${state.me ? " (" + state.me + ")" : ""}`,
    `בדיקת חיבור אחרונה שהצליחה: ${agoText(h.lastHeartbeatAt)}`,
    `הודעה אחרונה שנקלטה: ${lastText}`,
    `הודעות שנקלטו היום: ${store.messagesSince(Math.floor(startOfDay.getTime() / 1000))}`,
    `ניתוח אחרון שהצליח: ${agoText(h.lastGeminiOkAt)}`,
    `ממתינות לניתוח: ${stats.pending}`,
    `בדיקת "לא ענו" אחרונה: ${agoText(h.lastNoReplyCheckAt)}`,
  ];

  if (state.status === "qr") return { level: "bad", text: "לא מחובר - צריך לסרוק את קוד ה-QR בטלפון", details };
  if (state.status === "switching") return { level: "warn", text: "מנתק את הטלפון הקודם…", details };
  if (state.status !== "ready") return { level: "bad", text: `לא מחובר לוואטסאפ${state.lastError ? " - " + state.lastError : ""} - מנסה להתחבר מחדש`, details };
  if (h.whatsapp) return { level: "bad", text: h.whatsapp, details };
  if (state.backfill) return { level: "ok", text: state.backfill.total ? `עובד - קורא ${state.backfill.total} צ׳אטים עם הודעות חדשות (${state.backfill.done}/${state.backfill.total})` : "עובד - בודק אם יש צ׳אטים חדשים", details };

  const hbAge = ago(h.lastHeartbeatAt);
  const sinceStart = ago(h.startedAt);
  if (hbAge === null) return { level: "warn", text: sinceStart > 3 ? "מחובר, אבל עדיין לא הצלחתי לוודא שהחיבור חי" : "מחובר - מוודא שהחיבור חי…", details };
  if (hbAge !== null && hbAge > 4) return { level: "warn", text: `החיבור לוואטסאפ לא ענה לבדיקה כבר ${hbAge} דק׳ - בודק מחדש`, details };

  if (h.gemini) return { level: "warn", text: `וואטסאפ עובד. ${h.gemini}`, details };
  const gAge = ago(h.lastGeminiOkAt);
  if (stats.pending > 0 && (gAge === null ? sinceStart > 10 : gAge > 15)) {
    return { level: "warn", text: `וואטסאפ עובד, אבל ${stats.pending} הודעות ממתינות לניתוח ולא מתקדם`, details };
  }
  const tail = stats.pending > 0 ? ` · ${stats.pending} הודעות בניתוח` : " · הכל מעודכן";
  return { level: "ok", text: `הכל עובד${tail}`, details };
}
