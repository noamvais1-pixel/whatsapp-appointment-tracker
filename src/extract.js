import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config.js";

let ai = null;
const client = () => (ai ??= new GoogleGenAI({ apiKey: config.geminiKey }));

// Validates what Gemini returns before it touches the database.
const ItemSchema = z.object({
  action: z.enum(["create", "update", "cancel", "done"]),
  existing_id: z.number().nullable(),
  type: z.enum(["meeting", "call", "follow_up"]),
  title: z.string().min(1),
  who: z.string().nullable(),
  when_iso: z.string().nullable(),
  all_day: z.boolean(),
  when_text: z.string().nullable(),
  location: z.string().nullable(),
  notes: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  source_msg_id: z.string(),
  source_quote: z.string(),
});
const OutputSchema = z.object({ items: z.array(ItemSchema) });

// Same shape, written as JSON Schema for Gemini's structured output.
const nullable = (type, description) => ({ type: [type, "null"], description });
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "cancel", "done"] },
          existing_id: nullable("integer", "id of an existing open item this refers to; null for create"),
          type: { type: "string", enum: ["meeting", "call", "follow_up"] },
          title: { type: "string", description: "short, specific, e.g. 'Dentist appointment' or 'Send Dana the contract'" },
          who: nullable("string", "the other person/company involved"),
          when_iso: nullable("string", "local date-time as YYYY-MM-DDTHH:MM, or YYYY-MM-DD if only the day is known, or null if no date at all"),
          all_day: { type: "boolean", description: "true when only a day is known, no time" },
          when_text: nullable("string", "how the timing was phrased in the chat"),
          location: nullable("string"),
          notes: nullable("string", "anything useful: what to bring, agenda, what was promised"),
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          source_msg_id: { type: "string", description: "id of the message that established this" },
          source_quote: { type: "string", description: "the exact message text this came from, trimmed" },
        },
        required: ["action", "existing_id", "type", "title", "who", "when_iso", "all_day", "when_text", "location", "notes", "confidence", "source_msg_id", "source_quote"],
      },
    },
  },
  required: ["items"],
};

const SYSTEM = `You read WhatsApp conversations for one person ("Me") and keep their appointment tracker up to date.

Extract only things that are real commitments involving Me:
- meeting: an in-person or video appointment/meeting with a set or approximate time (doctor, client, coffee, school, viewing, delivery window, etc.)
- call: a phone/video call that was agreed or requested ("call me tomorrow", "let's talk at 4", "I'll ring you after lunch")
- follow_up: something Me promised to do or needs to chase, or something the other side promised Me that should be checked on ("I'll send you the quote", "let me know by Friday", "remind me to pay", "waiting on your confirmation")

Rules:
- Use the existing open items list to avoid duplicates. If new messages reschedule, confirm, cancel or complete an existing item, return action update/cancel/done with its existing_id instead of creating a new one. A mere "ok"/"great" confirming an item that already exists needs no output.
- Resolve relative dates ("tomorrow", "next Tuesday", "in two weeks") using the timestamp of the message that said it and the given timezone. If ambiguous, pick the most likely and set confidence to medium or low.
- Ignore small talk, jokes, past events already over, forwarded marketing, and vague "we should catch up sometime" unless a concrete time or promise is attached.
- A single message can produce several items. Both sides' messages count: something the other person will do for Me is a follow_up to check on.
- A time that one side only PROPOSED ("are you free today at 13:00?", "let's talk this evening") and the other side never confirmed is tentative: set confidence to "low" and start the notes with "מוצע, לא אושר". If the proposal was answered with a different time, use the agreed time.
- Titles are short and specific. Notes hold the detail. Do not invent details not in the messages.
- Return an empty items list when there is nothing actionable.
- Write title, notes, when_text and location in Hebrew (keep people's and business names as they appear in the chat).
- Respond with JSON only, matching the provided schema.`;

function fmtTs(ts, tz) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function renderMessages(msgs, tz) {
  return msgs
    .map((m) => `[${m.id}] ${fmtTs(m.ts, tz)} | ${m.from_me ? "Me" : m.sender || "Them"}: ${m.body.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

// Free-tier keys allow only a few requests per minute, so space calls out.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const slot = Math.max(nextSlot, now);   // reserve the next free slot before waiting, so parallel callers queue up
  nextSlot = slot + config.geminiMinIntervalMs;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

function retryHintMs(e) {
  const m = String(e?.message || e).match(/retry in ([\d.]+)s/i);
  return m ? Math.min(Number(m[1]) * 1000 + 500, 90_000) : null;
}

function isTransient(e) {
  const msg = String(e?.message || e);
  const status = e?.status ?? e?.code ?? msg.match(/"code":\s*(\d{3})/)?.[1];
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR|high demand|UNAVAILABLE/i.test(msg)
    || [429, 500, 502, 503, 504].includes(Number(status));
}

// Retries network blips, rate limits and server errors; gives up on anything else (bad key, bad request).
async function withRetry(fn, attempts = 4) {
  const delays = [2000, 5000, 12000];
  for (let i = 0; ; i++) {
    try {
      await throttle();
      return await fn();
    } catch (e) {
      const cause = e?.cause ? ` [${e.cause.code || e.cause.name || ""} ${String(e.cause.message || "").slice(0, 60)}]` : "";
      const msg = String(e?.message || e) + cause;
      if (!isTransient(e) || i >= attempts - 1) throw e;
      const wait = retryHintMs(e) ?? delays[Math.min(i, delays.length - 1)];
      console.warn(`[extract] ${msg.slice(0, 80)} - retrying in ${wait / 1000}s (${i + 1}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const CALL_TIMEOUT_MS = 90_000;
const withDeadline = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("fetch failed [timeout after 90s]"), { code: "ETIMEDOUT" })), ms))]);

async function generate({ system, prompt, schema }) {
  const call = (model) =>
    withDeadline(
      client().models.generateContent({
        model,
        contents: prompt,
        config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2, httpOptions: { timeout: CALL_TIMEOUT_MS } },
      }),
      CALL_TIMEOUT_MS + 5000,
    );
  try {
    return await withRetry(() => call(config.geminiModel));
  } catch (e) {
    if (!isTransient(e) || !config.geminiFallbackModel || config.geminiFallbackModel === config.geminiModel) throw e;
    console.warn(`[extract] ${config.geminiModel} unavailable, using ${config.geminiFallbackModel} for this request`);
    return await withRetry(() => call(config.geminiFallbackModel), 2);
  }
}

const JUDGE_SYSTEM = `You help one person ("Me") who runs a small business decide whether an unanswered WhatsApp conversation needs a follow-up.
You are shown the recent messages of one chat. Me sent the last message and the other side has not replied since.

Say needs_follow_up = true when the silence leaves something hanging that matters to Me:
- Me asked a question, requested a decision, confirmation, payment, document, or details, and got no answer
- Me sent a quote, offer, appointment proposal, or invitation that the other side never confirmed or declined
- Me is waiting on the other side to do something they said they would do
- Me promised to check, get back to them, send something, or call ("I'll check", "בבדיקה", "אחזור אליך") and the chat shows no sign that Me did - then Me owes them the follow-up

Say needs_follow_up = false when:
- the conversation reached a natural end (thanks, confirmations, goodbyes, "see you then", "sent", "done")
- Me's last message was purely informational, a reminder that needs no reply, a greeting, or a broadcast/marketing message
- the other side already answered the substance earlier and Me just added a closing remark
- the chat is with an automated bot/system, a delivery notice, or a one-way notification number

Be practical: reminders that are not really needed are annoying. When unsure, lean towards false unless money, an appointment, or a customer decision is at stake.
title: a short reminder Me can act on, in Hebrew, e.g. "לחזור לדנה בקשר להצעת המחיר" or "לבדוק עם דנה לגבי השכרת הכיתה". reason: one sentence in Hebrew. Respond with JSON only.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    needs_follow_up: { type: "boolean" },
    reason: { type: "string" },
    title: { type: "string" },
    urgency: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["needs_follow_up", "reason", "title", "urgency"],
};

/** Decide from context whether an unanswered chat needs a follow-up. */
export async function judgeFollowUp({ chatName, msgs, existingItems = [] }) {
  const tz = config.timezone;
  const existingText = existingItems?.length
    ? existingItems.map((i) => `- ${i.title}${i.when_iso ? ` (${i.when_iso})` : ""}`).join("\n")
    : "(none)";
  const prompt = `Chat: ${chatName}
Timezone: ${tz}
Current time: ${fmtTs(Math.floor(Date.now() / 1000), tz)}

Reminders that ALREADY exist for this chat (do not create another one for the same thing - answer needs_follow_up=false and say which one covers it):
${existingText}

Recent messages (oldest first; the last one is from Me and has had no reply):
${renderMessages(msgs, tz)}`;
  const response = await generate({ system: JUDGE_SYSTEM, prompt, schema: JUDGE_SCHEMA });
  if (!response.text) return null;
  try {
    const v = JSON.parse(response.text);
    if (typeof v.needs_follow_up !== "boolean") return null;
    return v;
  } catch {
    return null;
  }
}

export async function extractItems({ chatName, contextMsgs, newMsgs, existingItems }) {
  const tz = config.timezone;
  const now = fmtTs(Math.floor(Date.now() / 1000), tz);
  const existing = existingItems.length
    ? JSON.stringify(existingItems.map((i) => ({ id: i.id, type: i.type, title: i.title, who: i.who, when_iso: i.when_iso, when_text: i.when_text, notes: i.notes })))
    : "(none)";

  const prompt = `Chat: ${chatName}
Timezone: ${tz}
Current time: ${now}

Existing OPEN items already tracked for this chat:
${existing}

Earlier messages (already processed, for context only - do not extract from these):
${contextMsgs.length ? renderMessages(contextMsgs, tz) : "(none)"}

NEW messages to process:
${renderMessages(newMsgs, tz)}`;

  const response = await generate({ system: SYSTEM, prompt, schema: RESPONSE_JSON_SCHEMA });

  const text = response.text;
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason || response.promptFeedback?.blockReason || "empty response";
    console.warn(`[extract] no output for chat "${chatName}" (${reason}); skipping`);
    return [];
  }
  let parsed;
  try {
    parsed = OutputSchema.parse(JSON.parse(text));
  } catch (e) {
    console.warn(`[extract] unusable output for chat "${chatName}": ${e.message.split("\n")[0]}; skipping`);
    return [];
  }
  return parsed.items;
}
