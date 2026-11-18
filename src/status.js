import { state } from "./whatsapp.js";
import * as store from "./db.js";
import { updState } from "./updater.js";
import { tr } from "./i18n.js";

const MIN = 60_000;
const ago = (t) => (t ? Math.round((Date.now() - t) / MIN) : null);
const agoText = (t) => {
  const m = ago(t);
  if (m === null) return tr("עדיין לא", "not yet");
  if (m < 1) return tr("לפני פחות מדקה", "less than a minute ago");
  if (m < 60) return tr(`לפני ${m} דק׳`, `${m} min ago`);
  const h = Math.floor(m / 60);
  return h < 48 ? tr(`לפני ${h} שע׳`, `${h} h ago`) : tr(`לפני ${Math.floor(h / 24)} ימים`, `${Math.floor(h / 24)} days ago`);
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
    ? `${agoText(last.ts * 1000)} (${last.from_me ? tr("את אל", "you to ") : tr("מ", "from ")}${last.chat_name})`
    : tr("עדיין לא", "not yet");
  const today = store.messagesSince(Math.floor(startOfDay.getTime() / 1000));
  const details = [
    tr(`וואטסאפ: ${state.status === "ready" ? "מחובר" : "לא מחובר"}`, `WhatsApp: ${state.status === "ready" ? "connected" : "not connected"}`) + (state.me ? " (" + state.me + ")" : ""),
    tr(`בדיקת חיבור אחרונה שהצליחה: `, `Last successful connection check: `) + agoText(h.lastHeartbeatAt),
    tr(`הודעה אחרונה שנקלטה: `, `Last message received: `) + lastText,
    tr(`הודעות שנקלטו היום: `, `Messages received today: `) + today,
    tr(`ניתוח אחרון שהצליח: `, `Last successful analysis: `) + agoText(h.lastGeminiOkAt),
    tr(`ממתינות לניתוח: `, `Waiting for analysis: `) + stats.pending,
    tr(`בדיקת "לא ענו" אחרונה: `, `Last "no reply" check: `) + agoText(h.lastNoReplyCheckAt),
    updState.enabled
      ? tr(`עדכונים: נבדק `, `Updates: checked `) + agoText(updState.lastCheckAt) +
        (updState.current ? tr(` · גרסה `, ` · version `) + updState.current : "") +
        (updState.lastResult === "local-changes" ? tr(" · יש גרסה חדשה אבל שינויים מקומיים חוסמים", " · a new version is blocked by local changes") :
         updState.lastResult === "postponed" ? tr(" · גרסה חדשה תותקן כשהתוכנה תתפנה", " · a new version will install when the tracker is free") :
         updState.lastResult === "error" ? tr(` · שגיאה: `, ` · error: `) + updState.lastError :
         updState.lastResult === "up-to-date" ? tr(" · מעודכן", " · up to date") : "")
      : tr("עדכונים אוטומטיים: כבוי", "Automatic updates: off"),
  ];

  if (state.status === "qr") return { level: "bad", text: tr("לא מחובר - צריך לסרוק את קוד ה-QR בטלפון", "Not connected - scan the QR code with the phone"), details };
  if (state.status === "switching") return { level: "warn", text: tr("מנתק את הטלפון הקודם…", "Disconnecting the previous phone…"), details };
  if (state.status !== "ready") return { level: "bad", text: tr("לא מחובר לוואטסאפ", "Not connected to WhatsApp") + (state.lastError ? " - " + state.lastError : "") + tr(" - מנסה להתחבר מחדש", " - trying to reconnect"), details };
  if (h.whatsapp) return { level: "bad", text: h.whatsapp, details };
  if (state.backfill) return { level: "ok", text: state.backfill.total ? tr(`עובד - קורא ${state.backfill.total} צ׳אטים עם הודעות חדשות`, `Working - reading ${state.backfill.total} chats with new messages`) + ` (${state.backfill.done}/${state.backfill.total})` : tr("עובד - בודק אם יש צ׳אטים חדשים", "Working - checking for new chats"), details };

  const hbAge = ago(h.lastHeartbeatAt);
  const sinceStart = ago(h.startedAt);
  if (hbAge === null) return { level: "warn", text: sinceStart > 3 ? tr("מחובר, אבל עדיין לא הצלחתי לוודא שהחיבור חי", "Connected, but I couldn't confirm the connection is alive yet") : tr("מחובר - מוודא שהחיבור חי…", "Connected - checking the connection is alive…"), details };
  if (hbAge !== null && hbAge > 4) return { level: "warn", text: tr(`החיבור לוואטסאפ לא ענה לבדיקה כבר ${hbAge} דק׳ - בודק מחדש`, `WhatsApp hasn't answered a check for ${hbAge} min - checking again`), details };

  if (h.gemini) return { level: "warn", text: tr("וואטסאפ עובד. ", "WhatsApp works. ") + h.gemini, details };
  const gAge = ago(h.lastGeminiOkAt);
  if (stats.pending > 0 && (gAge === null ? sinceStart > 10 : gAge > 15)) {
    return { level: "warn", text: tr(`וואטסאפ עובד, אבל ${stats.pending} הודעות ממתינות לניתוח ולא מתקדם`, `WhatsApp works, but ${stats.pending} messages are waiting for analysis and it isn't moving`), details };
  }
  const tail = stats.pending > 0 ? tr(` · ${stats.pending} הודעות בניתוח`, ` · ${stats.pending} messages being analysed`) : tr(" · הכל מעודכן", " · all up to date");
  return { level: "ok", text: tr("הכל עובד", "All working") + tail, details };
}
