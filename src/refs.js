/**
 * "מספרים וקישורים" - pulls the reference data hiding inside the chat history:
 * phone numbers, bank details, ID numbers, invoice/order/confirmation numbers,
 * addresses and links. Everything you would otherwise scroll back to find.
 *
 * Runs straight off the messages table with plain regexes (no Gemini, nothing
 * leaves the machine), and caches until new messages arrive.
 */
import { db, getMeta } from "./db.js";
import { config } from "./config.js";

/* ---------------------------------------------------------------- helpers */

// Hebrew and Latin word characters, for "is the keyword a separate word" checks.
const digitsOnly = (s) => s.replace(/\D/g, "");

/** WhatsApp wraps phone numbers in bidi isolates; strip them plus any other invisibles. */
const clean = (s) => s.replace(/[‎‏⁦-⁩‪-‮]/g, "");

/* ------------------------------------------------------------------ types */
// Order matters: the first matcher to claim a stretch of text wins.

const TYPES = {
  link: { he: "קישור", icon: "🔗" },
  email: { he: "אימייל", icon: "✉️" },
  phone: { he: "טלפון", icon: "📞" },
  bank: { he: "פרטי בנק", icon: "🏦" },
  id: { he: "תעודת זהות", icon: "🪪" },
  ref: { he: "אסמכתא / הזמנה", icon: "🧾" },
  code: { he: "קוד", icon: "🔑" },
  address: { he: "כתובת", icon: "📍" },
  number: { he: "מספר", icon: "#️⃣" },
};

// Keywords that tell us what a number actually is.
const LABELS = [
  { type: "id", re: /(?:ת"?\.?ז|תעודת\s*זהות|ת\.?ז\.?)\s*[:\-]?\s*$/ },
  { type: "ref", re: /(?:אסמכתא|אסמכתה|מס'?\s*הזמנה|הזמנה\s*מס|מספר\s*הזמנה|חשבונית|קבלה|חשבון\s*מס|חש'?\s*מס|מס'?\s*חשבונית|משלוח|מעקב|tracking|invoice|receipt|order|ref|reference)\s*(?:מספר|מס'?|number|no\.?|#)?\s*[:\-]?\s*$/i },
  { type: "code", re: /(?:קוד|סיסמה|סיסמא|code|pin|otp|password)\s*(?:[֐-׿]{2,8}\s*)?[:\-]?\s*$/i },
  { type: "phone", re: /(?:טל'?|טלפון|נייד|פלאפון|וואטסאפ|ווצאפ|phone|mobile|tel)\s*[:\-]?\s*$/i },
];

/**
 * Bank details: branch + account read as one unit, because either alone is useless.
 * Tolerates the filler people write between them ("סניף: 159, מוטב: פלוני מספר חשבון 656591").
 */
const ACC_WORD = `(?:מס'?\\s*|מספר\\s*)?(?:חשבון|חש'?|ח"ן|ח׳ן|חן|חנ|ח[\\-\\s]ן|account)`;
const BANK_RE = new RegExp(
  // people write these across several lines, so newlines are allowed in the gap
  `סניף\\s*[:\\-]?\\s*(\\d{2,4})[^\\d]{0,40}?${ACC_WORD}\\s*[:\\-]?\\s*(\\d{4,12})` +
    `|${ACC_WORD}\\s*[:\\-]?\\s*(\\d{4,12})[^\\d]{0,40}?סניף\\s*[:\\-]?\\s*(\\d{2,4})`,
  "g",
);

/** Israeli phone numbers, with or without separators, local or +972. */
const PHONE_RE =
  /(?<![\d\w])(?:\+?972[\s\-.]?|0)(?:5[0-9]|7[2-9]|[2-489])[\s\-.]?\d{3}[\s\-.]?\d{4}(?![\d])|(?<![\d\w])0(?:[2-489])[\s\-.]?\d{7}(?![\d])/g;

/** Street addresses with a house number. */
const ADDRESS_RE =
  /(?:רח'|רח׳|רחוב|שד'|שדרות|שכונת|כתובת\s*[:\-]?)\s*([֐-׿\w"'׳״\-]+(?:\s+[֐-׿\w"'׳״\-]+){0,3}?)\s+(\d{1,4}[א-ת]?)\b/g;

// Hebrew is allowed inside the path (Israeli shops use it); a space always ends the link.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
const EMAIL_RE = /\b[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+\b/gi;

/** Things that look like numbers but are never worth saving. */
function isNoise(raw, before, after) {
  const d = digitsOnly(raw);
  if (!d) return true;
  // dates: 12/5/26, 12.5.2026, 2026-05-12, and anything starting with one
  if (/^\d{1,4}[./\-]\d{1,2}([./\-]\d{1,4})?\b/.test(raw)) return true;
  // times and time ranges
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) return true;
  if (/[:.]\s*$/.test(before) && /^\s*\d/.test(after)) return true;
  // a range or a quantity span ("בין 500-800", "20-30 נשים")
  if (/^\d{1,4}\s?-\s?\d{1,4}$/.test(raw)) return true;
  // a quantity, not an identifier
  if (/^\s*(?:נשים|אנשים|משתתפים|איש|ש"?ח|דק'|דקות|שעות|ימים|חודשים|שנים|ק"?ג|מ"?ר)\b/.test(after)) return true;
  // money
  if (/[₪$€]|ש"?ח|שקל|מע"?מ/.test(after.slice(0, 6)) || /[₪$€]\s*$/.test(before)) return true;
  if (/(?:מחיר|עולה|עלות|תשלום של|בסך|סה"?כ)\s*(?:של\s*)?$/.test(before)) return true;
  // a bare year, or a percentage
  if (/^(19|20)\d{2}$/.test(d)) return true;
  if (/^\s*%/.test(after)) return true;
  // repeated-digit filler ("100000", "11111")
  if (/^(\d)\1+$/.test(d)) return true;
  return false;
}

/* --------------------------------------------------------------- matching */

/** Everything worth keeping out of one message body. Returns [{type,value,display,label,start,end}]. */
export function extractFromText(text) {
  const src = clean(text || "");
  if (!src) return [];
  const out = [];
  const taken = []; // [start,end) ranges already claimed, so we never double-count
  const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
  const claim = (s, e) => taken.push([s, e]);
  const ctx = (s, e) => [src.slice(Math.max(0, s - 40), s), src.slice(e, e + 40)];

  // 1. links first - they are full of digits that must not be read as phone numbers
  for (const m of src.matchAll(URL_RE)) {
    const value = m[0].replace(/^www\./i, "https://www.");
    out.push({ type: "link", value, display: m[0], label: null, start: m.index, end: m.index + m[0].length });
    claim(m.index, m.index + m[0].length);
  }

  // 2. email addresses (before numbers - "t97608@gmail.com" is not a reference number)
  for (const m of src.matchAll(EMAIL_RE)) {
    if (!free(m.index, m.index + m[0].length)) continue;
    out.push({ type: "email", value: m[0].toLowerCase(), display: m[0], label: null, start: m.index, end: m.index + m[0].length });
    claim(m.index, m.index + m[0].length);
  }

  // 3. bank details (branch + account together)
  for (const m of src.matchAll(BANK_RE)) {
    if (!free(m.index, m.index + m[0].length)) continue;
    const branch = m[1] ?? m[4];
    const account = m[2] ?? m[3];
    out.push({
      type: "bank",
      value: `סניף ${branch} · חשבון ${account}`,
      display: `סניף ${branch} · חשבון ${account}`,
      label: m[0].trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
    claim(m.index, m.index + m[0].length);
  }

  // 4. phone numbers
  for (const m of src.matchAll(PHONE_RE)) {
    if (!free(m.index, m.index + m[0].length)) continue;
    const [before, after] = ctx(m.index, m.index + m[0].length);
    if (isNoise(m[0], before, after)) continue;
    const d = digitsOnly(m[0]).replace(/^972/, "0");
    if (d.length < 9 || d.length > 10) continue;
    out.push({ type: "phone", value: d, display: fmtPhone(d), label: null, start: m.index, end: m.index + m[0].length });
    claim(m.index, m.index + m[0].length);
  }

  // 5. addresses
  for (const m of src.matchAll(ADDRESS_RE)) {
    if (!free(m.index, m.index + m[0].length)) continue;
    const value = `${m[1]} ${m[2]}`.trim();
    out.push({ type: "address", value, display: value, label: null, start: m.index, end: m.index + m[0].length });
    claim(m.index, m.index + m[0].length);
  }

  // 6. any remaining run of 4+ digits, typed by the words in front of it
  for (const m of src.matchAll(/(?<![\d])[\d][\d\-/ ]{2,}[\d](?![\d])|(?<![\d])\d{4,}(?![\d])/g)) {
    const s = m.index, e = m.index + m[0].length;
    if (!free(s, e)) continue;
    const raw = m[0].trim();
    const d = digitsOnly(raw);
    if (d.length < 4) continue;
    const [before, after] = ctx(s, e);
    if (isNoise(raw, before, after)) continue;
    const hit = LABELS.find((l) => l.re.test(before));
    // no keyword? only keep it if it is long enough to plausibly be a reference
    if (!hit && d.length < 5) continue;
    let type = hit?.type ?? "number";
    if (type === "id" && d.length !== 9) type = "ref";
    out.push({ type, value: d, display: type === "phone" ? fmtPhone(d) : raw, label: hit ? before.trim().split(/\s{2,}|[\n]/).pop().trim() : null, start: s, end: e });
    claim(s, e);
  }

  return out.sort((a, b) => a.start - b.start);
}

function fmtPhone(d) {
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return d;
}

/* ------------------------------------------------------------ the gathering */

/** Trim a message down to a readable line of context around the value. */
function snippet(body, start, end) {
  const src = clean(body);
  const from = Math.max(0, start - 70);
  const to = Math.min(src.length, end + 70);
  let s = src.slice(from, to).replace(/\s+/g, " ").trim();
  if (from > 0) s = "…" + s;
  if (to < src.length) s += "…";
  return s;
}

const MEDIA_PREFIX = /^\[(תמונה|סרטון|הודעה קולית|קובץ שמע|קובץ[^\]]*|סטיקר)\]\s*/;

let cache = { sig: null, list: null };

/**
 * Every number and link found in the stored messages, deduplicated by value.
 * Each entry keeps every place it appeared (newest first), so a number always
 * arrives with its context, who sent it and when.
 */
export function allRefs() {
  const sig = db.prepare("SELECT COUNT(*) n, MAX(ts) t FROM messages").get();
  const key = `${sig.n}:${sig.t}`;
  if (cache.sig === key) return cache.list;

  const selfWid = getMeta("me_wid"); // set when WhatsApp links; used to spot the "message yourself" chat
  const selfUser = selfWid ? selfWid.split("@")[0] : null;

  const rows = db
    .prepare("SELECT id, chat_id, chat_name, from_me, sender, body, ts FROM messages ORDER BY ts DESC")
    .all();

  const byValue = new Map();
  for (const m of rows) {
    const body = String(m.body || "").replace(MEDIA_PREFIX, "");
    if (!body.trim()) continue;
    const isSelfChat = !!selfUser && String(m.chat_id).split("@")[0] === selfUser;
    for (const hit of extractFromText(body)) {
      const k = `${hit.type}:${hit.value}`;
      let entry = byValue.get(k);
      if (!entry) {
        entry = {
          key: k,
          type: hit.type,
          type_he: TYPES[hit.type].he,
          icon: TYPES[hit.type].icon,
          value: hit.value,
          display: hit.display,
          label: hit.label || null,
          self_note: false,
          from_me: false,
          count: 0,
          last_ts: 0,
          first_ts: Infinity,
          occurrences: [],
        };
        byValue.set(k, entry);
      }
      entry.count++;
      entry.self_note ||= isSelfChat;
      entry.from_me ||= !!m.from_me;
      entry.label ||= hit.label || null;
      entry.last_ts = Math.max(entry.last_ts, m.ts);
      entry.first_ts = Math.min(entry.first_ts, m.ts);
      if (entry.occurrences.length < 6) {
        entry.occurrences.push({
          msg_id: m.id,
          chat_id: m.chat_id,
          chat_name: m.chat_name,
          from_me: !!m.from_me,
          self_chat: isSelfChat,
          sender: m.from_me ? "את" : m.sender,
          ts: m.ts,
          context: snippet(body, hit.start, hit.end),
        });
      }
    }
  }

  const list = [...byValue.values()].sort(
    (a, b) => rank(b) - rank(a) || b.last_ts - a.last_ts,
  );
  cache = { sig: key, list };
  return list;
}

/** Self-notes first (that is where people stash things on purpose), then what you sent, then the rest. */
function rank(e) {
  let r = 0;
  if (e.self_note) r += 100;
  if (e.from_me) r += 10;
  if (e.label) r += 5;
  if (e.type !== "number") r += 2;
  if (e.count > 1) r += 1;
  return r;
}

export function refStats() {
  const list = allRefs();
  const byType = {};
  for (const e of list) byType[e.type] = (byType[e.type] || 0) + 1;
  return { total: list.length, byType, selfNotes: list.filter((e) => e.self_note).length };
}

export { TYPES as REF_TYPES };

/** Plain-text export, for pasting into a note or sending to yourself. */
export function refsText(list = allRefs()) {
  const fmtDate = (ts) =>
    new Date(ts * 1000).toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric", timeZone: config.timezone });
  return list
    .map((e) => {
      const o = e.occurrences[0];
      return `${e.icon} ${e.display}\n   ${e.type_he}${e.self_note ? " · פתק לעצמי" : ""} · ${o.chat_name || ""} · ${fmtDate(e.last_ts)}\n   ${o.context}`;
    })
    .join("\n\n");
}
