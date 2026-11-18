// Interface language. UI_LANG=en in .env shows this copy's dashboard, notifications and status
// texts in English (used for the second phone); anything else keeps Hebrew.
import fs from "node:fs";
import { ROOT } from "./config.js";

export const EN = (process.env.UI_LANG || "").toLowerCase().startsWith("en");
/** Pick the text for the current language. */
export const tr = (he, en) => (EN ? en : he);

// Words in the page that are data, not interface text: they mark contact cards and files inside
// stored message bodies, so the page's own code must keep matching them in Hebrew.
const KEEP = ["[איש קשר]", "[קובץ:"];
// "צ'אט" appears inside many phrases; it becomes a placeholder first so the phrase table can name it once.
const WORDS = [["צ\\'אטים", "\u0002CHATS\u0002"], ["צ'אטים", "\u0002CHATS\u0002"], ["צ\\'אט", "\u0002CHAT\u0002"], ["צ'אט", "\u0002CHAT\u0002"]];

/** The dashboard page in English: every Hebrew phrase from src/i18n-en.json, longest first. */
export function englishPage(page) {
  const pairs = JSON.parse(fs.readFileSync(`${ROOT}/src/i18n-en.json`, "utf8"))
    .map(([he, en]) => [he.replaceAll("CHATS", "\u0002CHATS\u0002").replace(/CHAT(?!S)/g, "\u0002CHAT\u0002"), en])
    .sort((a, b) => b[0].length - a[0].length);
  let s = page;
  KEEP.forEach((k, i) => (s = s.split(k).join(`\u0001${i}\u0001`)));
  for (const [k, v] of WORDS) s = s.split(k).join(v);
  // English values use ’ for apostrophes: a plain one would end the quoted strings in the page script
  for (const [he, en] of pairs) s = s.split(he).join(en.replaceAll("'", "’"));
  s = s.replaceAll("\u0002CHATS\u0002", "Chats").replaceAll("\u0002CHAT\u0002", "chat");
  KEEP.forEach((k, i) => (s = s.split(`\u0001${i}\u0001`).join(k)));
  return s
    .replace('<html lang="he" dir="rtl">', '<html lang="en" dir="ltr">')
    .replace("const L='he-IL';", "const L='en-GB';")
    .replace("el.dir=m&&", "el.dir=!m||"); // an empty text box starts left-to-right
}
