# Wingman

A proactive AI personal assistant that lives on WhatsApp. One Node process runs
everything: the Express API, the built web UI, the proactive schedulers, and the
WhatsApp client.

---

## Stack

- **Node 20** (`engines: >=20 <23`), CommonJS (`require`, not `import`)
- **Express 5** — `src/server.js` is the entry point
- **better-sqlite3** — synchronous SQLite. No ORM, no async/await on DB calls.
- **@anthropic-ai/sdk** — main LLM
- **whatsapp-web.js** (Puppeteer/Chromium) *or* WhatsApp Business Cloud API —
  see "WhatsApp has two modes" below
- **Vite + React + TypeScript** for the frontends

---

## Repo layout

```
src/
  server.js        entry point — routes, static serving, scheduler boot  (LARGE, ~43KB)
  config.js        SINGLE SOURCE OF TRUTH for all env vars — read this first
  api/             HTTP route handlers        (dashboard.js is ~52KB)
  auth/            Google OAuth, Shopify OAuth, session routes
  db/              one file per table + schema.sql. All sync (better-sqlite3).
  engine/          LLM tool definitions + executors  (systemPrompt.js is ~44KB)
  services/        integrations & business logic (gmail, calendar, recall, work…)
  whatsapp/        client.js (whatsapp-web.js) + cloudApi.js (Meta Cloud API)
  utils/           time, secrets, outbound URL helpers
  admin/qr.js      browser-based WhatsApp pairing page

app/               PRIMARY web UI (Vite PWA)  ← served at / when built
                   + the iOS/Android apps (Capacitor: app/ios, app/android — see app/MOBILE.md)
client/            LEGACY dashboard (Vite + Tailwind) ← fallback only
landing/           marketing site
mobile/            OLD React Native experiment — superseded by Capacitor (app/MOBILE.md)
bot-worker/        separate container: meeting notetaker bot (own Dockerfile)
scripts/           ad-hoc test scripts (test-*.js) — NOT a test suite
data/              SQLite DB lives here (gitignored)
```

### Which UI gets served

`config.js` picks the UI at boot:

```js
uiDist = fs.existsSync(app/dist/index.html) ? app/dist : client/dist
```

So **`app/` wins if it has been built.** If a UI change isn't showing up, check
which `dist` actually exists before debugging anything else.

---

## The engine pattern (important convention)

Every LLM capability is a **pair** of files in `src/engine/`:

- `xxxTools.js` — the tool *schemas* handed to Claude
- `xxxExecutor.js` — the functions that actually run when Claude calls them

Existing pairs: `gmail`, `calendar`, `drive`, `task`, `goal`, `health`, `maps`,
`memory`, `news`, `shopify`, `vault`, `voice`, `webmail`, `work`, `browser`,
`agent`, `audit`, `automation`, `integration`, `image`, `brain`, `records`.

**No keyword shortcuts.** Every inbound message goes to the assistant
(`handleMessage` → `runConversation`). Do not add regex "intents" that answer
before the model sees the message — they hijack real requests and only match
English. Expose the data as a tool instead (see `recordsTools.js`).

**To add a capability, add both files and register them** — don't put tool logic
in `services/`. `services/` is for integrations the executors call.

### Third-party apps go through Composio

New app integrations (Outlook/M365, Teams, Zoom, Slack, HubSpot, Pipedrive,
WooCommerce, Facebook, Instagram…) are **not** hand-built. `services/composio.js`
talks to Composio, and the `integration` engine pair exposes each user's
connected apps to Claude. Adding an app = create an auth config in Composio and
add it to `COMPOSIO_AUTH_CONFIGS` — no code. Gmail, Google Calendar, Shopify and
WhatsApp stay on their existing direct integrations.

### Images

`engine/imageTools.js` + `imageExecutor.js` give Claude `generate_image`
(Higgsfield, `services/higgsfield.js`) and `list_my_images`. Every image —
generated, or a photo the user sent on WhatsApp — is saved by
`services/mediaStore.js` on the data volume (`/app/data/media`) and served at
`/media/<uuid>.jpg`. That public URL is what Facebook/Instagram photo tools
take. Chat history is text-only, so the latest image URLs are appended to the
system prompt each turn (`recentImagesBlock`). Images are converted to JPEG
(`sharp`) because Instagram accepts nothing else.

### Understanding the user (app study + standing rules)

`services/appStudy.js` is how Wingman *understands* what a user connects. One
generic routine for every app: the model gets that app's READ-ONLY tools, looks
around, and writes a note to itself (`app_knowledge` table). First look runs
minutes after connecting, deepens on day 1 / 3 / 7, then refreshes weekly
(`scheduler` → `appStudy.runDue`). New Composio connections are noticed in
`composio.listConnections`; Shopify in its OAuth callback. The user is told the
timeline up front, in their own language. Notes are injected into every chat
(`knowledgeBlock`). Gmail/Calendar/Tasks are learned by the older
`onboardingAnalyzer` (7-day window, then weekly refresh). **Do not add per-app
study code** — improve the generic prompt instead. `APP_STUDY=0` disables it.

**Three layers of "knowing the user":** (1) live tools for fresh data/actions;
(2) memory in the prompt — `user_memory` facts, the distilled **profile card**
(`services/userProfile.js`, rebuilt when inputs change, ≤ daily) and the app notes
above; (3) **search over synced data** — `services/userIndex.js` keeps an SQLite
FTS5 index (`search_docs` / `search_fts`) over emails, meetings, events, tasks,
contacts, follow-ups and chats, synced every 15 min (backfilled at boot), exposed
as `search_user_data` / `open_user_record` (records tools). New synced tables
should be added to `SOURCES` in `userIndex.js`, not given their own search tool.

`engine/brainTools.js` + `brainExecutor.js` hold the user's standing rules
(`user_rules`): `auto_approve`, `always_ask`, `notify_mute`, `notify_always`.
An `auto_approve` rule lets ONE exact Composio tool skip the yes — it is itself
created through the approval gate, works in chat turns only, and is refused for
anything that deletes, moves money or spends an ad budget
(`canEverAutoApprove` in `integrationExecutor.js`). The general "act / ask /
tell / stay quiet" policy lives in `judgementGuide` in `systemPrompt.js`.

**Every write action is gated server-side** (`integration_actions` table): it is
parked as pending and only runs after the user sends a NEW message and the model
calls `approve_integration_action`. Do not add a bypass. (The one sanctioned exception is a user's own
`auto_approve` rule, described above.)

### WhatsApp's 24h window (read before sending anything)

Outside 24h since the user's last WhatsApp message, Meta silently drops
free-form text. `whatsapp/client.js` handles this in ONE place:
`sendMessage` checks the window (only real WhatsApp inbound counts — in-app chat
rows carry `source: 'app'` and don't) and, outside it, sends the generic
`PROACTIVE_TEMPLATE_NAME` template; if that would lose content, or a template
is already waiting unanswered, the full text goes to `held_messages` and is
delivered the moment the user next messages (`deliverHeld`, called from the
webhook). Pass `{ urgent: true }` only for time-critical pings. Never call
`cloudApi.sendText` for proactive messages — use `sendMessage` /
`sendProactiveMessage`.

**Accounts (sign up / sign in):** the app starts with an account — Apple,
Google or email + password (`api/accountRoutes.js`, `db/accounts.js`, table
`accounts`; passwords scrypt-hashed, one-time tokens stored hashed in
`account_tokens`). A new account answers `needs_phone` + `account_token`; the app
then verifies the WhatsApp number and passes `account_token` to `/verify-otp`,
which links the account to the phone-keyed user (an existing WhatsApp user keeps
all their data). Linked accounts answer `signed_in` with a session. Phone-only
sign-in still works for old users. Forgot password sends the reset code to the
account's WhatsApp. Google/Apple are redirect flows ending at
`#/auth-callback?code=…` → `POST /api/auth/exchange`; Google never joins an
email account whose address wasn't verified. Google is on with
`GOOGLE_SIGNIN_CLIENT_ID` (or `GOOGLE_SIGNIN_ENABLED=1` to reuse the main client);
Apple needs `APPLE_TEAM_ID`, `APPLE_SERVICES_ID`, `APPLE_KEY_ID`,
`APPLE_PRIVATE_KEY`. `scripts/test-accounts.js` checks it all offline.

**Sign-in:** `/api/auth/request-otp` sends the code itself — plain text inside
the 24h window, otherwise the AUTHENTICATION template `wingman_login_otp`
(`OTP_USE_TEMPLATE=1`). If it can't be sent it returns 503 with a clear error;
there is no "message us to get your code" flow in the app. Users are stored
with their full international number (`users.create`; old 10-digit rows
self-heal from the webhook via `upgradePhone`).

### Voice notes in chat (ElevenLabs)

`services/voice.js`: a WhatsApp voice note is transcribed by ElevenLabs Scribe
(any Urdu-script transcript is rewritten to Roman Urdu by the cheap model), then
handled exactly like typed text. Replies go back as a voice note too
(`voice_replies`: `on_voice` default / `always` / `off`) in the user's chosen
voice. Default for everyone is Wingman's own voice — `ELEVENLABS_VOICE_ID`, the
same voice as the calls — unless they asked for another (`voice_name`: george,
daniel, brian, matilda, sarah, alice, river). Old OpenAI names fall back to the
default. OpenAI is used only when there's no ElevenLabs key.
`scripts/test-voice-chat.js` checks it offline.

### Voice briefings (ElevenLabs)

`services/briefingCall.js` + `services/elevenlabs.js`. A user turns on "Voice
briefing" (app Profile screen, or the `set_briefing_call` brain tool; stored in
`preferences.briefingCall`). Then:
- every FULL briefing/wrap (after "View Briefing") also goes out as a voice note
  (ElevenLabs TTS, Ogg/Opus) — works on any number today;
- when `ELEVENLABS_CALLS=1` and an agent exists, `runDueUsers` places a WhatsApp
  call instead of sending text. The agent gets the briefing as dynamic variables
  and asks Wingman's brain mid-call via `POST /voice/tools/ask` (per-call token +
  shared secret; `answerForCall` runs as an *automated* turn, so nothing can be
  approved from a call). The scheduler's minute tick polls the call: answered →
  a note in chat history; missed → normal text briefing (+ voice note). Calls
  pause after 2 misses in a row (Meta revokes permission after 4).
Users can also CALL Wingman on WhatsApp (ElevenLabs imported the WABA with
messaging OFF — messages still come to us). ElevenLabs' conversation-initiation
webhook hits `POST /voice/inbound` (same secret header); `briefingCall.inbound`
finds the user by caller number, creates a `voice_calls` row (`kind='inbound'`,
`status='live'`) with a call token, and returns dynamic variables + greeting.
Unknown callers get no token (no data). Inbound calls never count as misses.
Every call (both directions) gets Wingman's memory as `{{brain}}`
(`briefingCall.brainContext`: memory facts, profile card + app notes, standing
rules, last chat messages) and, for inbound, an instant DB snapshot of today
(`quickSnapshot`). `services/preBriefing.js` runs ~30 min before each user's
briefing/wrap: syncs calendar, Gmail, Google Tasks, business mail, profile card
and the search index, and pre-builds the briefing for callers
(`preferences.prebuilt`) so the call starts instantly.
WhatsApp only allows business-initiated calls from NON-US/Canada business
numbers with a 2K+ messaging limit — the +1 number cannot place calls.
**Calls never go quiet:** `/voice/tools/ask` → `briefingCall.ask` waits
`ELEVENLABS_TOOL_BUDGET_MS` (2.5 s) for the answer; a longer lookup returns
`{status:'working', job_id}` at once and keeps running, the agent keeps talking
(asks a related question) and fetches it via the `wingman_result` tool
(`/voice/tools/result` → `briefingCall.result`). An answer never fetched (call
ended) is sent on WhatsApp after 90 s. Re-run `scripts/setup-voice-agent.js`
after changing the agent prompt/tools.
**Phone channel:** `ELEVENLABS_CALL_CHANNEL=phone` + `ELEVENLABS_PHONE_NUMBER_ID`
(a Twilio number imported into ElevenLabs) makes briefing calls normal phone
calls to the user's number via `el.startPhoneCall` (`/v1/convai/twilio/outbound-call`)
— no Meta permission or number rules. Same agent, variables and polling.
`scripts/setup-voice-agent.js` creates/updates the agent; `scripts/test-voice.js`
checks the key live.

### Uber rides (book a cab for the user)

`engine/rideTools.js` + `rideExecutor.js`, `services/uber.js` (Uber **Guest Rides
API**, Uber for Business — the business account pays), `db/rides.js` (table
`rides`), `services/rideTracker.js`. Flow: `get_ride_options` (pickup defaults to
the user's CURRENT location — a WhatsApp location pin is saved as that by the
webhook; older than 30 min → ask them to share it again) → user picks →
`book_ride`, which is in `BUILTIN_GATED` **and** `ALWAYS_CONFIRM`, so it waits for
the user's yes even when Composio is off; at booking it re-quotes and refuses if
the fare rose > `UBER_MAX_FARE_RISE` (15%). The tracker polls active rides every
`UBER_POLL_SECONDS` (and `POST /webhooks/uber`, HMAC with the client secret,
nudges it) and messages the user once each: driver/car/plate, "~2 min away",
"your cab is here", arrived + fare, or driver cancelled / no drivers.
`cancel_ride` is gated too. Env: `UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`,
`UBER_ORG_ID`, `UBER_SANDBOX=1` for testing. **Without those keys it runs in link
mode**: the ride tools return an Uber universal link (+ Lyft backup) with pickup
and drop pre-filled; the user books in their own app (no gate, nothing spent,
no tracking). `scripts/test-rides.js` checks both modes offline.

### Chat knows everything the app shows

The assistant must never send the user to the app for information. App data
has chat tools: `email_overview` (the app's email list: Gmail + business, real
`received_at`, type incl. cancellation, needs-reply), `needs_attention` (the
Home card: overdue tasks, emails waiting, today's clashes), `delete_task` /
`update_task`. Email lists carry the real received time (`email_items.received_at`,
Gmail `internalDate`) and are newest first; `created_at` is only when Wingman
processed it. **Google connection health** (`services/googleConnection.js`):
`invalid_grant` / `unauthorized_client` mark the user (`preferences.googleAuth`),
tools return `GOOGLE_RECONNECT_NEEDED`, the user gets one WhatsApp link a day,
and the OAuth callback clears it.

### Security rules

- Admin/debug routes use `utils/adminAuth.js` (`requireAdmin`) — fails closed.
- Connect links must be built with `utils/linkSig.js` `connectQuery(phone)`;
  OAuth `state` with `signState` / `verifyState`. Unsigned links get a 403.
- Webhook POSTs are HMAC-checked when `WHATSAPP_APP_SECRET` is set.
- Gmail / business-mail sends, `delete_event`, `delete_drive_file`,
  `share_drive_file`, `book_ride` and `cancel_ride` go through the same server-side approval gate as app tools
  (`BUILTIN_GATED` in `integrationExecutor.js`).

### Tests (run before every deploy)

```bash
node scripts/test-whatsapp-window.js   # 24h window, held messages, sign-in by reply (offline)
node scripts/test-engine-offline.js    # approval gate, loop end, tool memory, caching (scripted model)
node scripts/test-briefing-call.js     # voice briefings: calls, fallbacks, voice notes (fake ElevenLabs)
node scripts/test-voice-chat.js        # chat voice notes on ElevenLabs (fake fetch)
node scripts/test-accounts.js          # sign up / sign in / linking / reset (temp server)
node scripts/test-rides.js             # Uber booking: options, yes-gate, tracker messages (fake Uber)
node scripts/test-app-parity.js        # tasks delete/edit, email times/order, Gmail vs business, app parity, expired Google
docker exec wingman node scripts/eval-live.js   # real model, fake data, temp DB (~cents)
```

---

## Config & environment

**`src/config.js` is the only place env vars are read.** Never call
`process.env.X` elsewhere — add it to `config.js` instead. It is heavily
commented; those comments explain *why* each default is what it is. Read them
before changing a default.

Several config sections expose an `enabled` getter (`shopify.enabled`,
`gemini.enabled`, `nowhrms.enabled`, …). A feature with no credentials degrades
gracefully rather than crashing — preserve that behaviour.

### Models

| Purpose | Env var | Default |
| --- | --- | --- |
| Main chat (WhatsApp) | `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| Deep reasoning (proactive brain, goal planning) | `ANTHROPIC_MODEL_DEEP` | `claude-opus-5` |
| Cheap/high-volume (email classify, behaviour learning) | `ANTHROPIC_MODEL_CHEAP` | `claude-haiku-4-5` |
| Meeting transcription | `GEMINI_MODEL` | `gemini-2.5-flash` |
| Voice notes in chat (STT + TTS) | `ELEVENLABS_API_KEY` | Scribe (`ELEVENLABS_STT_MODEL`) / `eleven_multilingual_v2` |
| Voice fallback (only if no ElevenLabs key) | `OPENAI_API_KEY` | Whisper / gpt-4o-mini-tts |

**`GEMINI_MODEL` is pinned to a GA version on purpose — never set it to a
`*-latest` alias.** The alias silently moved to a "thinking" flash once and
transcripts came back empty. Transcription also sets `thinkingBudget: 0`.

> `.env.example` is not always in sync with `config.js`. When they disagree,
> `config.js` is right. If you add a var, update both.

---

## WhatsApp has two modes

1. **Cloud API** (Meta official) — used automatically when `WHATSAPP_TOKEN` and
   `WHATSAPP_PHONE_NUMBER_ID` are both set. No Chromium needed. Preferred in prod.
2. **whatsapp-web.js** — Puppeteer-driven. Needs Chromium, needs QR pairing at
   `/admin/qr?key=$ADMIN_PASSWORD`, and stores its session in `.wwebjs_auth/`.

`DISABLE_WHATSAPP=1` runs API + UI only — useful for local UI work and screenshots.

### Message templates (Cloud API)

Outside WhatsApp's 24h customer-service window, only approved templates can be
sent. Template parameter counts differ per template (`BRIEFING`=6, `WRAP`=7,
`PROACTIVE`=1), so **they must never fall back to one another.** WhatsApp also
forbids newlines inside a template variable — that is why `BRIEFING_READY_TEMPLATE`
uses a quick-reply button to reopen the window before sending rich content.

---

## Deployment

**Production runs on a DigitalOcean droplet as a Docker container.**

> `DEPLOYMENT.md` in this repo documents the OLD Railway setup and is stale.
> Do not follow it. `railway.json` is likewise a leftover.

The container binds to `127.0.0.1:3000` behind a reverse proxy, takes its env
from `--env-file .env` on the droplet, and mounts a host volume for persistent
data.

### State that must survive a redeploy

| Data | Path in container |
| --- | --- |
| SQLite DB | `/app/data/wingman.db` (`DATABASE_PATH`) |
| WhatsApp session | `/app/data/.wwebjs_auth` (`WHATSAPP_SESSION_PATH`) |

Keep the WhatsApp session on the **same mounted volume** as the DB, otherwise
every deploy forces a fresh QR scan.

### Env changes don't need a rebuild

If only `.env` changed, recreate the container — a full image rebuild is wasted
time. Code changes need a rebuild.

---

## Never commit

`.env` · `*.db` · `.wwebjs_auth/` · `.wwebjs_cache/` ·
`bot-worker/google-state.json` (a signed-in Google session — a real secret) ·
`*.state.json`

All are in `.gitignore`. Check before staging; some of these files exist on disk
right now.

---

## Working in this repo

- **Large files** — `api/dashboard.js` (~52KB), `engine/systemPrompt.js` (~44KB),
  `src/server.js` (~43KB), `whatsapp/client.js` (~28KB), `db/schema.sql` (~23KB).
  Search within them; don't read them whole without reason.
- **No CI.** `scripts/test-*.js` are run by hand (see "Tests" above). Don't
  assume `npm test` exists.
- **DB access is synchronous.** Don't `await` better-sqlite3 calls or wrap them
  in promises.
- **Schema changes** go in `src/db/schema.sql`; `npm run initdb` applies it.
- The user writes and reads **English and Roman Urdu** — transcription and STT
  settings deliberately keep Roman Urdu in Latin script. Don't "fix" that to Urdu
  script.

## Commands

```bash
npm start                      # node src/server.js
npm run initdb                 # apply src/db/schema.sql
npm run build:client           # build the LEGACY client/ UI
cd app && npm run build        # build the PRIMARY app/ UI

# local prod-ish preview, no WhatsApp:
NODE_ENV=production DISABLE_WHATSAPP=1 ADMIN_PASSWORD=demo npm start
```


## Business mail sending (SMTP relay)
- DigitalOcean blocks outbound SMTP (25/465/587) from the droplet, so business-mail replies can't reach the user's own SMTP server directly.
- `relay/smtp-relay-worker.js` is a Cloudflare Worker (Wingman's Cloudflare account, wingman01.app@gmail.com) that logs in to the user's SMTP server over 465/587 and delivers the message. Nothing is stored there.
- `src/services/smtpRelay.js` + `webmail.send`: compose the RFC 822 message (threaded), POST it to the relay, then IMAP-append a copy to the user's Sent folder. Brevo is only a fallback for connection failures.
- Env: `SMTP_RELAY_URL`, `SMTP_RELAY_SECRET` (= Worker secret `RELAY_SECRET`). Test: `node scripts/test-smtp-relay.js`.
- Gmail sends/replies use the Gmail API (HTTPS), not SMTP.
