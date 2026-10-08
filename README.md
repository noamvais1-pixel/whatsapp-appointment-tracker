# WhatsApp appointment tracker

Links to a WhatsApp account (any phone, not just this computer's), reads the chats,
and keeps a list of **meetings, phone calls and follow-ups** it finds in them.
You get a dashboard at http://localhost:3123, Mac notifications when something new
is found, and optionally a daily agenda sent to your own WhatsApp number.

## One-time setup

1. Get a free Gemini API key at https://aistudio.google.com/apikey (the app uses Gemini to
   understand the messages).
2. Open the `.env` file in this folder and paste the key after `GEMINI_API_KEY=`.
3. Open Terminal in this folder and run:

   ```bash
   npm install
   ```

## Running it

**Double-click "מעקב פגישות" (Appointment Tracker) on the Desktop.** It starts the tracker in the
background and opens the dashboard in its own window (not a browser). If the tracker is
already running it just opens the window. Drag it to the Dock if you like.

**Closing the window stops nothing**: the tracker keeps reading messages in the background
and the WhatsApp link stays as it is. Open the window again whenever you like.

To really stop it, click **Quit** in the dashboard. The next launch reconnects to WhatsApp
(usually 10-60 seconds, no new scan).

Optional: double-click `Start at login (optional).command` inside the project folder to
make it start by itself whenever you log in to this Mac (double-click again to turn that off).

The Terminal way still works too:

```bash
npm start
```

The first time, a QR code appears in the Terminal and on http://localhost:3123.
On the phone whose WhatsApp you want tracked, open **WhatsApp → Settings (or the ⋮ menu)
→ Linked devices → Link a device** and scan it. The link is remembered in `data/`,
so you only scan once.

It then reads the last 14 days of chats (change `BACKFILL_DAYS` in `.env`), and after
that watches for new messages while it is running. Leave the Terminal window open;
close it (or press Ctrl+C) to stop.

## The dashboard

Three views at the top: **משימות** (tasks: the meetings and follow-ups), **מספרים וקישורים**
(numbers and links, see below) and **צ'אטים** (chats):
a WhatsApp-Web-style list of all chats with search, last message and unread count. Opening a
chat shows the contact's phone number under the name in the conversation header. Clicking a
chat opens the conversation next to it, and you can write and send from there.

- **Today / Upcoming / Overdue / Follow-ups / No date** tabs.
- **Done**, **Cancel**, **Reopen**, and **Date** buttons on each item.
- Each item shows the exact message it came from, so you can check it.
- **Voice notes, images, videos and files** show inside the conversation as a blurred preview
  with a **download** button. Nothing is fetched by itself, only what you click. Once downloaded:
  a voice note with a player, an image (click to open full size in Preview), a video player, and a
  file button that opens the file in the right Mac app. Documents (PDF, Word...) and videos get a
first-page preview after download, like Finder shows; before download WhatsApp provides no preview
for documents, so only the file name is shown. Downloads are kept in `data/media`. Files
  over 40 MB are skipped, and very old media WhatsApp no longer holds says so, with a retry.
- **Sending images and files:** in the conversation, click 📎, drag a file onto the chat, or
  paste an image (Cmd+V) into the text box. The file shows above the box with a preview (the image,
or the first page of a document) and a remove button;
  whatever you type is sent as the caption. JPG/PNG/WebP/GIF go as images, everything else as a
  document. Up to 45 MB.
- Add your own items with the box at the top.
- **Check new messages now** re-reads recent chat history from WhatsApp and extracts anything pending right away.
- **Today's agenda** shows the same text the daily WhatsApp digest sends.

If a chat later reschedules or cancels something, the item is updated instead of
duplicated. When someone says "sent it" / "done", the follow-up is closed. Images count too:
the analysis receives the small preview WhatsApp ships with every image (nothing is downloaded),
so a screenshot of a bank transfer, a receipt or the requested document closes the matching
follow-up. Files without a preview (PDFs) are judged by context: a file you send right after
being asked for something is taken as that thing.

**Click an item's title** to open that chat in a side panel. You see the recent
messages from the linked account, the message the item came from is highlighted, and
you can type a reply that is sent through the linked WhatsApp (not the desktop one).

**iPhone calendar.** Every meeting or call with a date is mirrored into the Mac Calendar app,
into the calendar named in `CALENDAR_NAME` (currently "עבודה", an iCloud calendar, so it shows
on the iPhone). A calendar the app creates itself lands outside iCloud and never reaches the
phone, so to use a separate calendar create it on the iPhone under iCloud first, then name it here. Items that are in the
calendar show a "📅 ביומן" badge. Meetings are 60 minutes, calls 30, with a 30-minute alert
(all adjustable in `.env`). Date changes move the event, cancellations delete it, done items
keep it. Follow-ups are not added. macOS asks once for permission to control Calendar.

**Deleted and edited messages.** Every message is stored the moment it arrives. If the sender
later deletes it for everyone, it vanishes on the phone but stays here, marked in red with the
deletion time. A message deleted while the app was off is usually marked once it runs again,
without the time. Edited messages show the new text with an "edited" marker; hover to see the
original. This only covers messages that arrived while the app was running.

**Past appointments.** A meeting or call whose time passed more than 12 hours ago
(`AUTO_CLOSE_PAST_HOURS`): a confirmed one is closed as "done" and moves to the done tab;
a time that was only proposed and never answered is not closed but becomes a follow-up
("get an answer from X about …") dated today, so it stays on the list until you deal with it.
Follow-ups are never closed automatically.

**Unanswered messages.** If you wrote last in a chat and nobody answered for 24 hours
(`NO_REPLY_HOURS`), the app reads the recent conversation and decides whether a follow-up
is really needed: an open question, an unconfirmed quote or appointment, a refund you are
chasing, or something you promised to get back to them about. Pure "thanks / see you"
endings and bots are skipped. The reminder shows the reason, and it closes itself when
they reply or when you write to them from the panel.

## Numbers and links (מספרים וקישורים)

A searchable index of the reference data buried in the chat history, so you never scroll back
looking for an account number or a Zoom link. Built with plain regexes over the stored messages -
no Gemini, nothing leaves the machine.

Picks up phone numbers, bank details (branch + account read as one unit, even across line breaks),
ID numbers, invoice / receipt / order / tracking references, codes, emails, street addresses and
URLs. Long unlabelled numbers land in their own `מספר` tab rather than polluting the rest.

- Every value keeps **its context**: the sentence it appeared in, who sent it, which chat, and when.
- **Search matches both the value and the surrounding text** - `0504287709`, `שער`, `zoom`, or a
  person's name all work; hyphens in numbers are ignored.
- Repeated values are deduplicated into one row with an "X more places" expander.
- Anything you sent is tagged **שלחת**; anything in the **Message yourself** chat is tagged
  **פתק לעצמי** and sorted to the top, since that is where people deliberately stash things.
  (The self-chat is matched against the linked account's own WhatsApp id, stored in `meta.me_wid`
  when the phone links, so it only kicks in after the next link/backfill.)
- **Copy** for one value, **העתקת הכל** for the whole list as plain text, **לצ'אט** to jump to
  the exact message.

Endpoints: `GET /api/refs` (JSON) and `GET /api/refs/export` (plain text).

## Opening it on your phone

The dashboard listens on every network interface, so any device on the same Wi-Fi can reach
it. Find this Mac's address and open it in the phone's browser:

```sh
ipconfig getifaddr en0          # Wi-Fi.  en1 if you are on Ethernet.
```

Then on the phone: `http://<that-address>:3123`. The tracker prints the same URL when it
starts. Both devices have to be on the same Wi-Fi, and the Mac has to be awake.

**Read this before you do.** The dashboard shows raw message content - bank details, ID
numbers, addresses. Without `DASHBOARD_PASSWORD` set in `.env`, *anyone* on that network can
open the same URL and read all of it. No password, no prompt. That is fine on a home network
you control and a bad idea on café, hotel, office or campus Wi-Fi.

| `.env` setting | Effect |
|---|---|
| `DASHBOARD_PASSWORD=` *(blank)* | No gate. Open to everyone on the network. |
| `DASHBOARD_PASSWORD=something` | Phone asks for the password once, then remembers it for 30 days. |
| `DASHBOARD_TRUST_LOCALHOST=true` *(default)* | This Mac skips the password, so the desktop app is unaffected. |
| `BIND_HOST=127.0.0.1` | Locks the dashboard to this Mac. Nothing on the network can reach it. |

The password travels over plain HTTP, so it keeps honest people out; it is not protection
against someone capturing traffic on the network. To sign a device out again, delete
`data/session-secret` and restart - every saved login stops working.

### Adding it to the home screen

In Safari on the phone: **Share → Add to Home Screen**. It then opens full-screen with its
own icon instead of as a browser tab. It is still the same local server, so it only works
when the Mac is awake and on the same Wi-Fi - there is no offline copy of your data.

### Reaching it from outside the house

Not set up, deliberately. It would need a tunnel or port-forward, which puts this server on
the public internet. Before doing that you would want the password gate on, HTTPS so the
password is not sent in the clear, and preferably a VPN back to the house instead of an open
port. A WhatsApp archive on a public URL behind one shared password is a bigger risk than it
looks.

## Settings (`.env`)

| Setting | What it does |
|---|---|
| `TIMEZONE` | So "tomorrow at 3" lands on the right day. Blank = this Mac's timezone. |
| `BACKFILL_DAYS` | How far back to read on first link. |
| `IGNORE_GROUPS` | `true` keeps group chats out of appointment scanning (recommended). Groups still appear in the dashboard chat list. |
| `ONLY_CHATS` / `SKIP_CHATS` | Comma-separated contact names or numbers to include / exclude. |
| `CALENDAR_NAME` | Mac calendar that receives meetings and calls. `CALENDAR_SYNC=false` turns it off. |
| `CALENDAR_MEETING_MINUTES` / `CALENDAR_CALL_MINUTES` / `CALENDAR_ALARM_MINUTES` | Event lengths and the alert, in minutes. |
| `AUTO_UPDATE` / `AUTO_UPDATE_HOURS` | Self-update from GitHub and how often to check. |
| `DAILY_DIGEST_TIME` | e.g. `08:00` to get the day's agenda in your own WhatsApp chat ("You"). Blank = off. |
| `GEMINI_MODEL` | Which Gemini model to use. `gemini-3.5-flash-lite` (default) is the only one a free key can use all day: a free key gets just ~20 requests a day on `gemini-3.5-flash` or `gemini-3.8-flash`. With billing enabled, switch to one of those. |
| `GEMINI_MIN_INTERVAL_MS` | Gap between Gemini requests. `13000` suits a free key; lower it to `1000` if you enable billing. |
| `GEMINI_FALLBACK_MODEL` | Used automatically when the main model is overloaded or out of quota. Default `gemini-3.5-flash-lite`. |
| `AUTO_CLOSE_PAST_HOURS` | Hours after a meeting/call time before it is closed automatically. `0` = never. |
| `NO_REPLY_HOURS` | If you wrote last in a chat and nobody answered for this many hours, a follow-up reminder appears. It closes itself when they reply. `0` turns it off. |
| `PORT` | Dashboard port. |
| `CHROME_PATH` | Path to Google Chrome (needed for the WhatsApp link). |

## Sleep

When the Mac sleeps, the tracker sleeps with it and reads nothing. So while it runs, it
keeps the Mac from going to idle-sleep (the display can still turn off). Closing the lid
still puts the Mac to sleep. To turn this off: `KEEP_AWAKE=false` in `.env`. After a wake,
the tracker reconnects to WhatsApp on its own.

## Good to know

- **Privacy:** message text from the chats you allow, plus the small image previews, is sent to Google's Gemini API for
  extraction. Everything else stays on this Mac in `data/`. Use `ONLY_CHATS` to limit it.
- **Free Gemini keys are rate-limited.** The app spaces its requests out, so the first
  read of a busy account takes a while (a few messages a minute). The dashboard header
  shows how many messages are still waiting. Enabling billing on the key and lowering
  `GEMINI_MIN_INTERVAL_MS` makes it much faster.
- **Unofficial link:** this uses the same "linked device" mechanism as WhatsApp Web
  through an unofficial library. WhatsApp can in principle object to automated linked
  devices; the app only reads and, if enabled, sends the daily digest to yourself.
- **Voice notes** can be played in the chat panel but are not transcribed, so the analysis does not know what was said in them.
- **Switching to another phone:** click **Switch phone** in the dashboard. It removes the
  linked device from the current phone, asks whether to keep or delete the items that came
  from it, and shows a new QR code for the next phone.
- To start over completely, delete the `data/` folder.

## How you know it is working

The strip at the top of the window is the answer. It is green ("everything works") only when
the app has just proven it: every minute it asks WhatsApp whether the link is alive, and every
message received and every successful analysis is recorded. Click the strip for the evidence:
last successful link check, last message received, last successful analysis, messages waiting.

- **Green**: working. "N messages being analysed" means analysis is in progress and will finish by itself.
- **Yellow**: WhatsApp works, but something secondary is stuck (for example Gemini). The app keeps retrying.
- **Red**: not working, and it says why. If it needs you (for example a QR scan), it says so.

A Mac notification is sent when the state changes from working to not working, or back.
After the Mac sleeps, the app checks the link immediately and reconnects on its own.

## Self-update

Once a day (and 3 minutes after each start) the app checks the GitHub repository. When a newer
version exists it pulls it, reinstalls dependencies (which re-applies the WhatsApp library patches)
and restarts itself cleanly, with no new QR scan. The status strip shows the last check and the
running version; **בדיקת עדכונים** in the header checks immediately. `AUTO_UPDATE=false` turns it
off. Updates are skipped while the local copy has uncommitted code changes, so nothing is lost.

## If something stops working

The app checks itself. If WhatsApp changes something and chats can no longer be read, a red
banner appears at the top of the dashboard and a Mac notification is sent. The same happens
if the link drops, and a yellow banner shows Gemini key or quota problems. The app cannot fix
a WhatsApp change on its own: the library it relies on is maintained by volunteers, and the fix
arrives days or weeks after the change. When the red banner appears, the app needs an update.

## If chat reading breaks after a WhatsApp update

The `patches/` folder holds fixes for the WhatsApp library (upstream pull requests #201850 chat list, #201923 sending media, #201697 and #201932 downloading media)
that is re-applied automatically after `npm install`. If chats stop loading with an error
that just says "r", check whether a newer `whatsapp-web.js` release includes the fix.

## Command line

```bash
npm run digest
```
prints today's agenda without starting anything.
