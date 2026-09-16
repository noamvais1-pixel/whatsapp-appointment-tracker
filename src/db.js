import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  from_me INTEGER NOT NULL,
  sender TEXT,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS messages_unprocessed ON messages(processed) WHERE processed = 0;

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- meeting | call | follow_up
  title TEXT NOT NULL,
  who TEXT,
  chat_id TEXT,
  chat_name TEXT,
  when_iso TEXT,                   -- ISO 8601 local time, or NULL if unknown
  all_day INTEGER NOT NULL DEFAULT 0,
  when_text TEXT,                  -- how it was phrased ("next Tuesday afternoon")
  location TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | done | cancelled
  confidence TEXT,
  source_msg_id TEXT,
  source_quote TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS items_status_when ON items(status, when_iso);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Media attachments (voice notes, images, videos, documents) downloaded on demand.
db.exec(`CREATE TABLE IF NOT EXISTS media (
  msg_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- ok | failed | too_large
  mimetype TEXT, filename TEXT, path TEXT, size INTEGER, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
if (!db.prepare("PRAGMA table_info(messages)").all().some((c) => c.name === "media_type")) {
  db.exec("ALTER TABLE messages ADD COLUMN media_type TEXT");
}

// Added later: which mechanism created the item ('' = extracted from chat text, 'noreply' = unanswered-message reminder)
if (!db.prepare("PRAGMA table_info(items)").all().some((c) => c.name === "kind")) {
  db.exec("ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
}

const stmts = {
  insertMsg: db.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, chat_name, from_me, sender, body, ts, processed, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  setMediaType: db.prepare(`UPDATE messages SET media_type = ? WHERE id = ? AND media_type IS NULL`),
  recentMessages: db.prepare(
    `SELECT m.*, md.status AS media_status, md.mimetype AS media_mime, md.filename AS media_filename, md.size AS media_size, md.error AS media_error
       FROM messages m LEFT JOIN media md ON md.msg_id = m.id WHERE m.chat_id = ? ORDER BY m.ts DESC LIMIT ?`,
  ),
  getMedia: db.prepare(`SELECT * FROM media WHERE msg_id = ?`),
  saveMedia: db.prepare(`INSERT OR REPLACE INTO media (msg_id, status, mimetype, filename, path, size, error) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  deleteMedia: db.prepare(`DELETE FROM media WHERE msg_id = ?`),
  staleFailedMedia: db.prepare(
    `SELECT md.msg_id FROM media md JOIN messages m ON m.id = md.msg_id
      WHERE md.status = 'failed' AND m.chat_id = ? AND m.ts >= ? AND md.created_at < datetime('now', '-30 minutes')`,
  ),
  unprocessedChats: db.prepare(
    `SELECT chat_id, chat_name, COUNT(*) AS n, MIN(ts) AS oldest FROM messages WHERE processed = 0 GROUP BY chat_id ORDER BY oldest`,
  ),
  unprocessedInChat: db.prepare(
    `SELECT * FROM messages WHERE chat_id = ? AND processed = 0 ORDER BY ts`,
  ),
  contextBefore: db.prepare(
    `SELECT * FROM messages WHERE chat_id = ? AND processed = 1 AND ts < ? ORDER BY ts DESC LIMIT ?`,
  ),
  markProcessed: db.prepare(`UPDATE messages SET processed = 1 WHERE id = ?`),
  openItemsForChat: db.prepare(
    `SELECT * FROM items WHERE chat_id = ? AND status = 'open' ORDER BY when_iso`,
  ),
  insertItem: db.prepare(
    `INSERT INTO items (type, title, who, chat_id, chat_name, when_iso, all_day, when_text, location, notes, confidence, source_msg_id, source_quote, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  updateItem: db.prepare(
    `UPDATE items SET type = ?, title = ?, who = ?, when_iso = ?, all_day = ?, when_text = ?, location = ?, notes = ?, confidence = ?, source_msg_id = ?, source_quote = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  setStatus: db.prepare(
    `UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ),
  getItem: db.prepare(`SELECT * FROM items WHERE id = ?`),
  allItems: db.prepare(
    `SELECT * FROM items ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, when_iso IS NULL, when_iso, id DESC`,
  ),
  openItems: db.prepare(
    `SELECT * FROM items WHERE status = 'open' ORDER BY when_iso IS NULL, when_iso`,
  ),
  addHistory: db.prepare(`INSERT INTO history (item_id, action, detail) VALUES (?, ?, ?)`),
  historyFor: db.prepare(`SELECT * FROM history WHERE item_id = ? ORDER BY id`),
  setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
  editItem: db.prepare(
    `UPDATE items SET title = COALESCE(?, title), when_iso = COALESCE(?, when_iso), notes = COALESCE(?, notes), type = COALESCE(?, type), updated_at = datetime('now') WHERE id = ?`,
  ),
  chatSummaries: db.prepare(
    `SELECT m.chat_id AS id, m.chat_name AS name, m.ts AS timestamp, m.body AS last_body, m.from_me AS last_from_me
       FROM messages m JOIN (SELECT chat_id, MAX(ts) AS mts FROM messages GROUP BY chat_id) x
         ON m.chat_id = x.chat_id AND m.ts = x.mts ORDER BY m.ts DESC`,
  ),
  lastMessagePerChat: db.prepare(
    `SELECT m.* FROM messages m JOIN (SELECT chat_id, MAX(ts) AS mts FROM messages GROUP BY chat_id) x
       ON m.chat_id = x.chat_id AND m.ts = x.mts`,
  ),
  noReplyItemForMsg: db.prepare(`SELECT id, status FROM items WHERE kind = 'noreply' AND source_msg_id = ?`),
  openNoReplyForChat: db.prepare(`SELECT id FROM items WHERE kind = 'noreply' AND chat_id = ? AND status = 'open'`),
  todayCount: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ts >= ?`),
  lastMessage: db.prepare(`SELECT chat_name, from_me, ts FROM messages ORDER BY ts DESC LIMIT 1`),
  stats: db.prepare(
    `SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM messages WHERE processed = 0) AS pending, (SELECT COUNT(*) FROM items WHERE status = 'open') AS open_items`,
  ),
};

export function saveMessage(m, processed = 0) {
  const r = stmts.insertMsg.run(m.id, m.chatId, m.chatName, m.fromMe ? 1 : 0, m.sender, m.body, m.ts, processed, m.mediaType ?? null);
  if (r.changes === 0 && m.mediaType) stmts.setMediaType.run(m.mediaType, m.id); // older rows saved before media support
  return r.changes > 0;
}
export const getMedia = (id) => stmts.getMedia.get(id);
export const saveMedia = (r) => stmts.saveMedia.run(r.msg_id, r.status, r.mimetype ?? null, r.filename ?? null, r.path ?? null, r.size ?? null, r.error ?? null);
export const deleteMedia = (id) => stmts.deleteMedia.run(id);
export const staleFailedMedia = (chatId, sinceTs) => stmts.staleFailedMedia.all(chatId, sinceTs).map((r) => r.msg_id);
export const recentMessages = (chatId, limit = 60) => stmts.recentMessages.all(chatId, limit).reverse();
export const unprocessedChats = () => stmts.unprocessedChats.all();
export const unprocessedInChat = (chatId) => stmts.unprocessedInChat.all(chatId);
export const contextBefore = (chatId, ts, limit = 30) => stmts.contextBefore.all(chatId, ts, limit).reverse();
export const markProcessed = (ids) => {
  const tx = db.transaction ? null : null; // node:sqlite has no transaction helper yet
  db.exec("BEGIN");
  try {
    for (const id of ids) stmts.markProcessed.run(id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
export const openItemsForChat = (chatId) => stmts.openItemsForChat.all(chatId);
export function insertItem(it) {
  const r = stmts.insertItem.run(
    it.type, it.title, it.who ?? null, it.chat_id ?? null, it.chat_name ?? null, it.when_iso ?? null,
    it.all_day ? 1 : 0, it.when_text ?? null, it.location ?? null, it.notes ?? null, it.confidence ?? null,
    it.source_msg_id ?? null, it.source_quote ?? null, it.kind ?? "",
  );
  const id = Number(r.lastInsertRowid);
  stmts.addHistory.run(id, "created", it.source_quote ?? null);
  return id;
}
export function updateItem(id, it) {
  stmts.updateItem.run(
    it.type, it.title, it.who ?? null, it.when_iso ?? null, it.all_day ? 1 : 0, it.when_text ?? null,
    it.location ?? null, it.notes ?? null, it.confidence ?? null, it.source_msg_id ?? null, it.source_quote ?? null, id,
  );
  stmts.addHistory.run(id, "updated", it.source_quote ?? null);
}
export function setStatus(id, status, detail = null) {
  stmts.setStatus.run(status, id);
  stmts.addHistory.run(id, status, detail);
}
export function editItem(id, fields) {
  stmts.editItem.run(fields.title ?? null, fields.when_iso ?? null, fields.notes ?? null, fields.type ?? null, id);
  if (fields.when_iso) db.prepare("UPDATE items SET all_day = ? WHERE id = ?").run(fields.when_iso.length === 10 ? 1 : 0, id);
  stmts.addHistory.run(id, "edited", JSON.stringify(fields));
}
export const getItem = (id) => stmts.getItem.get(id);
export const allItems = () => stmts.allItems.all();
export const openItems = () => stmts.openItems.all();
export const historyFor = (id) => stmts.historyFor.all(id);
export const setMeta = (k, v) => stmts.setMeta.run(k, String(v));
export const getMeta = (k) => stmts.getMeta.get(k)?.value ?? null;
export const stats = () => stmts.stats.get();
export const messagesSince = (ts) => stmts.todayCount.get(ts).n;
export const lastMessage = () => stmts.lastMessage.get();
export function wipeAll() {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM history; DELETE FROM items; DELETE FROM messages; DELETE FROM meta WHERE key LIKE 'noreply:%' OR key = 'last_backfill_ts';");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export const lastMessagePerChat = () => stmts.lastMessagePerChat.all();
export const chatSummaries = () => stmts.chatSummaries.all();
export const noReplyItemForMsg = (msgId) => stmts.noReplyItemForMsg.get(msgId);
export function closeNoReply(chatId, detail = "they replied") {
  let n = 0;
  for (const row of stmts.openNoReplyForChat.all(chatId)) { setStatus(row.id, "done", detail); n++; }
  return n;
}
