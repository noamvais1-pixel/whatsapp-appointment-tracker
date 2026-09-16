import { config } from "./config.js";
import * as store from "./db.js";

const DAY = 86400000;

export function localDateKey(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: config.timezone }); // YYYY-MM-DD
}

export function fmtWhen(it) {
  if (!it.when_iso) return it.when_text || "בלי תאריך";
  const [date, time] = it.when_iso.split("T");
  const d = new Date(date + "T12:00:00");
  const day = d.toLocaleDateString("he-IL", { weekday: "short", day: "numeric", month: "short" });
  return time && !it.all_day ? `${day} ${time}` : day;
}

export function buildDigest(now = new Date()) {
  const today = localDateKey(now);
  const weekEnd = localDateKey(new Date(now.getTime() + 7 * DAY));
  const items = store.openItems();
  const key = (it) => (it.when_iso || "").slice(0, 10);
  const icon = { meeting: "📅", call: "📞", follow_up: "✅" };
  const line = (it) => `${icon[it.type]} ${fmtWhen(it)} - ${it.title}${it.who ? ` (${it.who})` : ""}`;

  const overdue = items.filter((it) => key(it) && key(it) < today);
  const todays = items.filter((it) => key(it) === today);
  const week = items.filter((it) => key(it) > today && key(it) <= weekEnd);
  const undated = items.filter((it) => !key(it) && it.type === "follow_up");

  const parts = [`*סדר היום ל${now.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: config.timezone })}*`];
  parts.push(todays.length ? `\n*היום*\n${todays.map(line).join("\n")}` : "\n*היום*\nאין כלום מתוכנן.");
  if (overdue.length) parts.push(`\n*באיחור / לא סומן כבוצע*\n${overdue.map(line).join("\n")}`);
  if (week.length) parts.push(`\n*7 הימים הקרובים*\n${week.map(line).join("\n")}`);
  if (undated.length) parts.push(`\n*מעקבים בלי תאריך*\n${undated.map(line).join("\n")}`);
  return parts.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("digest.js")) {
  console.log(buildDigest().replace(/\*/g, ""));
}
