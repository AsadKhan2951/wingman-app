-- ══════════════════════════════════════════════════════════════════
--  WINGMAN — SQLite Schema
--  Notes:
--   * IDs are TEXT (UUIDs generated in app code via crypto.randomUUID())
--   * JSONB replaced with TEXT (JSON.parse/stringify in code)
--   * TIMESTAMP DEFAULT NOW() replaced with TEXT DEFAULT (datetime('now'))
--   * Tables marked "user-specified" match Aamir's exact definitions.
-- ══════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ─── Users (user-specified) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  timezone TEXT DEFAULT 'Asia/Karachi',
  work_hours_start TEXT DEFAULT '09:00',
  work_hours_end TEXT DEFAULT '18:00',
  language TEXT DEFAULT 'en',
  -- Legacy single-account token columns. Kept in sync with the PRIMARY row in
  -- google_accounts so older code paths keep working; google_accounts is the
  -- source of truth once a user links more than one Google account.
  gmail_token TEXT,
  calendar_token TEXT,
  shopify_domain TEXT,                           -- e.g. mystore.myshopify.com
  shopify_token TEXT,                            -- Admin API access token
  health_connected INTEGER DEFAULT 0,
  preferences TEXT DEFAULT '{}',
  onboarding_complete INTEGER DEFAULT 0,
  briefing_time TEXT DEFAULT '07:00',
  debrief_time TEXT DEFAULT '20:00',
  voice_replies TEXT DEFAULT 'on_voice',          -- 'off' | 'on_voice' | 'always'
  voice_name TEXT DEFAULT 'nova',
  assistant_name TEXT DEFAULT 'Wingman',          -- users can rename the assistant
  health_token TEXT,
  webmail_address TEXT,                          -- business email (IMAP/SMTP)
  webmail_password_enc TEXT,                     -- AES-256-GCM encrypted, never plaintext
  webmail_imap_host TEXT,
  webmail_imap_port INTEGER,
  webmail_smtp_host TEXT,
  webmail_smtp_port INTEGER,
  webmail_from_name TEXT,
  home_address TEXT,
  home_lat REAL,
  home_lng REAL,
  office_address TEXT,
  office_lat REAL,
  office_lng REAL,
  news_topics TEXT DEFAULT '["world","nation","technology","local"]',
  news_city TEXT,
  news_country TEXT,
  proactiveness_level TEXT DEFAULT 'moderate',   -- 'low' | 'moderate' | 'high'
  autonomy_level TEXT DEFAULT 'small',           -- 'ask' | 'small' | 'act' — how far it may act unprompted
  quiet_hours_start TEXT,                         -- local HH:MM; avoid non-urgent pings between these
  quiet_hours_end TEXT,
  runs_business INTEGER DEFAULT 1,               -- whether the user runs a business (unlocks store/ops framing)
  enabled_skills TEXT DEFAULT '["travel_assistant","bill_tracker","delivery_tracker","people_crm","followup_tracker"]',
  tone TEXT DEFAULT 'friendly',                  -- 'professional' | 'casual' | 'friendly'
  communication_style TEXT DEFAULT 'concise',    -- 'concise' | 'detailed'
  avatar_url TEXT,                               -- the user's Google profile photo URL
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Goals: a longer-term goal + AI action plan + proactive coaching ─
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,                            -- the goal, e.g. "Learn to play tennis"
  detail TEXT,                                    -- optional extra context from the user
  status TEXT DEFAULT 'active',                   -- 'active' | 'done' | 'dropped'
  plan TEXT DEFAULT '[]',                         -- JSON: [{ step, done }] action plan
  progress INTEGER DEFAULT 0,                     -- 0-100, from plan steps completed
  target_date TEXT,                              -- optional date the user wants it by
  last_nudge_at TEXT,                            -- last proactive nudge (once/day guard)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

-- ─── Agent actions: an audit trail of what Wingman did for the user ──
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                            -- e.g. 'chat.create_task', 'bill.paid', 'meeting.notes'
  summary TEXT NOT NULL,                         -- human-readable one-liner
  source TEXT DEFAULT 'chat',                    -- 'chat' (user asked) | 'proactive' (did on its own)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_user ON agent_actions(user_id, created_at);

-- ─── Credential vault: third-party logins the agent can USE but never READ ──
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,                           -- e.g. "electricity portal", "Netflix"
  username TEXT,                                 -- the login/email (NOT secret)
  secret_enc TEXT NOT NULL,                      -- AES-256-GCM encrypted; never plaintext, never shown to the LLM
  url TEXT,                                      -- optional site URL for automation
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

-- ─── Auth: OTP codes (phone verification / login) ───────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT DEFAULT 'login',    -- 'login' | 'signup'
  expires_at TEXT NOT NULL,
  consumed INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  -- Reply-to-verify: when the code can't be pushed to the user (new number,
  -- outside the 24h window, no AUTHENTICATION template), the user messages
  -- Wingman "WM-<ref>" from their WhatsApp. That proves they own the number:
  -- confirmed = 1, the code is sent back, and the app (holding poll_secret)
  -- can sign in without typing it.
  ref TEXT,
  poll_secret TEXT,
  confirmed INTEGER DEFAULT 0,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Auth: sessions (bearer tokens for the web app) ─────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT DEFAULT (datetime('now'))
);

-- ─── Conversations (user-specified) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  role TEXT,
  content TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Tasks (user-specified) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  title TEXT,
  source TEXT,
  priority INTEGER DEFAULT 3,
  due_date TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  recurring TEXT,
  google_task_id TEXT,
  google_tasklist_id TEXT,
  google_account_id TEXT,
  google_updated_at TEXT,
  sync_state TEXT DEFAULT 'local_only',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Email items (user-specified) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS email_items (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  gmail_id TEXT,
  account_id TEXT,
  account_email TEXT,
  subject TEXT,
  sender TEXT,
  category TEXT,
  summary TEXT,
  action_needed INTEGER DEFAULT 0,
  replied INTEGER DEFAULT 0,
  draft_reply TEXT,
  detected_type TEXT,
  extracted_data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Bills (user-specified) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT,
  amount REAL,
  currency TEXT DEFAULT 'PKR',
  due_date TEXT,
  status TEXT DEFAULT 'pending',
  recurring INTEGER DEFAULT 0,
  source_email_id TEXT REFERENCES email_items(id),
  last_alerted_at TEXT,
  reminder_count INTEGER DEFAULT 0,   -- how many times we've nudged; capped so we don't nag forever
  paid_at TEXT,                       -- when it was actually marked paid (for the behaviour layer's timing patterns)
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Deliveries (user-specified; completed to match spec) ───────────
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  item_name TEXT,
  merchant TEXT,
  carrier TEXT,
  tracking_number TEXT,
  status TEXT DEFAULT 'in_transit',
  estimated_delivery TEXT,
  delivered_at TEXT,
  return_window_ends TEXT,
  source_email_id TEXT REFERENCES email_items(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Calendar events (spec-aligned) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  gcal_event_id TEXT,
  account_id TEXT,                 -- which linked Google account this came from
  account_email TEXT,
  title TEXT,
  description TEXT,
  location TEXT,
  start_time TEXT,
  end_time TEXT,
  all_day INTEGER DEFAULT 0,
  attendees TEXT DEFAULT '[]',
  status TEXT,
  has_conflict INTEGER DEFAULT 0,
  meeting_url TEXT,                 -- Google Meet / Zoom / Teams join link, if any
  meeting_provider TEXT,           -- 'meet' | 'zoom' | 'teams' | null
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Travel (spec-aligned) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS travel (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  trip_name TEXT,
  type TEXT,
  provider TEXT,
  confirmation_code TEXT,
  origin TEXT,
  destination TEXT,
  depart_time TEXT,
  arrive_time TEXT,
  status TEXT,
  price REAL,
  currency TEXT DEFAULT 'PKR',
  source_email_id TEXT REFERENCES email_items(id),
  return_time TEXT,
  hotel_name TEXT,
  hotel_checkin TEXT,
  hotel_checkout TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Health data (spec-aligned) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_data (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  source TEXT,
  metric_type TEXT,
  value REAL,
  unit TEXT,
  recorded_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Contacts / People CRM (spec-aligned) ───────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT,
  phone TEXT,
  email TEXT,
  relationship TEXT,
  company TEXT,
  birthday TEXT,
  last_contacted_at TEXT,
  last_summary TEXT,
  notes TEXT,
  interaction_count INTEGER DEFAULT 0,
  strength TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Briefings (spec-aligned) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  type TEXT,
  content TEXT,
  payload TEXT DEFAULT '{}',
  sent_at TEXT,
  engagement TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Reminders / proactive jobs (spec-aligned) ──────────────────────
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  kind TEXT,
  ref_id TEXT,
  message TEXT,
  trigger_at TEXT,
  status TEXT DEFAULT 'scheduled',
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Follow-ups (promises made / received) ──────────────────────────
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  type TEXT,                       -- 'promise_made' | 'promise_received'
  description TEXT,
  counterparty TEXT,               -- who it's to/from
  due_date TEXT,
  status TEXT DEFAULT 'open',      -- 'open' | 'done' | 'overdue_alerted'
  source_email_id TEXT REFERENCES email_items(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─── Indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_user     ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user             ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_completed        ON tasks(completed);
CREATE INDEX IF NOT EXISTS idx_email_items_user       ON email_items(user_id);
CREATE INDEX IF NOT EXISTS idx_email_items_category   ON email_items(category);
CREATE INDEX IF NOT EXISTS idx_bills_user             ON bills(user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_user        ON deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_user          ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_travel_user            ON travel(user_id);
CREATE INDEX IF NOT EXISTS idx_health_user            ON health_data(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user          ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_briefings_user         ON briefings(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_trigger      ON reminders(trigger_at, status);
CREATE INDEX IF NOT EXISTS idx_followups_user         ON followups(user_id, status);
CREATE INDEX IF NOT EXISTS idx_otp_phone               ON otp_codes(phone, consumed);
CREATE INDEX IF NOT EXISTS idx_sessions_user           ON sessions(user_id);
-- Google accounts linked to a Wingman user. A user may connect several
-- (personal + work); exactly one is flagged is_primary and drives sends/creates.
CREATE TABLE IF NOT EXISTS google_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,                                    -- null until backfilled for legacy rows
  token TEXT NOT NULL,                           -- JSON OAuth tokens
  scopes TEXT,
  is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_google_accounts_user ON google_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_accounts_user_email ON google_accounts(user_id, email);

-- Durable things Wingman has learned about a user (habits, preferences,
-- relationships, ongoing projects). Injected into the system prompt so the
-- assistant carries context across conversations instead of starting fresh.
CREATE TABLE IF NOT EXISTS user_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT,                   -- preference | habit | relationship | project | context
  fact TEXT NOT NULL,
  source TEXT DEFAULT 'learned',   -- 'learned' (inferred) | 'explicit' (user told us)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);

-- ─── Work sessions (clock in / clock out) ───────────────────────────
--   Source-agnostic: an HRMS webhook, or the user telling Wingman directly.
--   An open session is one with clock_out_at IS NULL.
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  clock_in_at TEXT,
  clock_out_at TEXT,
  day_key TEXT,               -- local YYYY-MM-DD of clock-in, so "today" is the user's today
  source TEXT,                -- 'hrms' | 'told_to_wingman'
  nudged_at TEXT,             -- set once we have asked about clocking out
  snooze_until TEXT,          -- set when they say they are staying late
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_sessions_user_day ON work_sessions(user_id, day_key);

-- ─── Wearable accounts (Whoop, Oura, …) ─────────────────────────────
--   One row per user per provider. Tokens are encrypted at rest; a wearable
--   token exposes months of health history, so it is treated like a password.
CREATE TABLE IF NOT EXISTS wearable_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  provider TEXT,                 -- 'whoop' | 'oura' | …
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at TEXT,
  scopes TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wearable_user_provider
  ON wearable_accounts(user_id, provider);

-- ─── Automations (standing instructions the AI fulfils on schedule) ──
--   NOT to-do tasks (things the USER does). These are things WINGMAN does by
--   itself at a time — "every morning at 7 send me the traffic to the office".
--   The instruction is kept in natural language and executed by the AI with its
--   tools, so any capability Wingman has can be scheduled without a bespoke rule.
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  instruction TEXT,              -- "send a traffic update from office to home"
  time TEXT,                     -- local HH:MM
  kind TEXT,                     -- 'daily' | 'weekdays' | 'weekly' | 'once'
  weekday INTEGER,               -- 0=Sun..6=Sat, for 'weekly'
  run_date TEXT,                 -- 'YYYY-MM-DD', for 'once'
  timezone TEXT,
  last_run_date TEXT,            -- local day it last fired (dedupe)
  anchor TEXT,                   -- e.g. 'usual_finish' → fire time tracks a learned behaviour (null = fixed time)
  lead_minutes INTEGER,          -- minutes BEFORE the anchor to fire (e.g. 25)
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id, active);

-- ─── Meetings (noted/recorded meetings → AI summary + action items) ──
--   A meeting the user held. Raw notes (typed now; transcribed audio later) are
--   turned into a structured summary + action items by Claude, then optionally
--   emailed to the attendees who have an address, and to the user.
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  type TEXT,                     -- 'Product' | 'Client' | 'Internal' | 'Sales' | 'Partner'
  company TEXT,
  location TEXT,
  virtual INTEGER DEFAULT 0,
  attendees TEXT DEFAULT '[]',   -- JSON [{ name, email, role }]
  notes TEXT,                    -- raw notes (typed now; transcript later)
  summary TEXT,                  -- JSON { overview, discussion[], decisions[], actions[], openQuestions[], followUps[] }
  status TEXT DEFAULT 'scheduled', -- scheduled | in-progress | processing | summary-ready | completed | cancelled
  meeting_at TEXT,               -- ISO time the meeting happened
  emailed_at TEXT,               -- when the summary was emailed out
  recording_url TEXT,            -- Google Drive link to the saved audio recording
  tasks_created INTEGER DEFAULT 0, -- 1 once action items were turned into real tasks
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id);

-- ─── Meeting notetaker bot sessions ─────────────────────────────────
-- One row per attempt to send the Wingman bot into a live call. The browser
-- worker (separate host) drives the join/record; the backend owns scheduling,
-- status, and turning the returned audio into a summary via the meeting pipeline.
CREATE TABLE IF NOT EXISTS meeting_bots (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  meeting_id TEXT,                 -- our meetings.id (created up front so the app shows it)
  gcal_event_id TEXT,             -- calendar event that triggered it (null for manual joins)
  meeting_url TEXT NOT NULL,      -- the join link the worker opens
  provider TEXT,                  -- 'meet' | 'zoom' | 'teams'
  bot_name TEXT,                  -- display name in the call, e.g. 'Wingman Notetaker'
  recall_bot_id TEXT,             -- Recall.ai bot id when the Recall engine drives the join
  -- scheduled → dispatched → joining → waiting → recording → processing → done | failed | cancelled
  status TEXT DEFAULT 'scheduled',
  worker_token TEXT,              -- per-session secret the worker presents to post audio/status
  scheduled_at TEXT,              -- when the meeting starts (ISO)
  started_at TEXT,                -- when the worker actually joined
  ended_at TEXT,                  -- when recording stopped
  error TEXT,                     -- last failure reason, if any
  recording_url TEXT,             -- Drive link once saved
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- ─── Outbound WhatsApp de-dup guard ────────────────────────────────
-- Atomic reservation so the SAME message to the SAME number can't be sent
-- twice within a short window — protects against a brief two-instance overlap
-- during a redeploy (or any accidental double-send). Keyed on
-- (digits:text-hash:2-min-bucket); INSERT OR IGNORE = one wins, the other skips.
CREATE TABLE IF NOT EXISTS wa_send_dedup (
  key TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_bots_user ON meeting_bots(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_bots_status ON meeting_bots(status);
-- Not UNIQUE: a cancelled/failed attempt must be able to be re-dispatched, so a
-- second row for the same event is allowed. dispatchForEvent() guards against
-- two *active* sessions via findActiveForEvent().
CREATE INDEX IF NOT EXISTS idx_meeting_bots_event ON meeting_bots(user_id, gcal_event_id);

-- ─── Integration approval gate (Composio write actions) ─────────────
-- Every third-party action that changes something (send, post, create, update,
-- delete) is parked here first and only runs after the user says yes in a LATER
-- message. `after_msg_rowid` = the user's newest conversation rowid when the
-- action was proposed; approval requires a user message with a higher rowid, so
-- the model can never approve its own proposal in the same turn. No bypass flag.
CREATE TABLE IF NOT EXISTS integration_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  toolkit TEXT NOT NULL,                 -- e.g. 'outlook', 'slack'
  tool_slug TEXT NOT NULL,               -- e.g. 'OUTLOOK_SEND_EMAIL', or '__DISCONNECT__'
  tool_version TEXT,                     -- schema version the model saw
  arguments TEXT NOT NULL DEFAULT '{}',  -- JSON
  summary TEXT,                          -- human-readable preview shown to the user
  status TEXT NOT NULL DEFAULT 'pending', -- pending | executing | done | failed | cancelled | expired
  after_msg_rowid INTEGER NOT NULL DEFAULT 0,
  result TEXT,                           -- JSON (truncated)
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_integration_actions_user ON integration_actions(user_id, status);

-- ─── "Reply for the full version" after a template briefing/wrap ────
-- Outside the 24h window only a short UTILITY template goes out. When it does,
-- we note it here; the user's next WhatsApp message (which re-opens the window)
-- triggers the full rich briefing/wrap once, then the row is cleared.
CREATE TABLE IF NOT EXISTS pending_full_sends (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- 'briefing' | 'wrap'
  expires_at TEXT NOT NULL,           -- UTC 'YYYY-MM-DD HH:MM:SS'
  PRIMARY KEY (user_id, kind)
);

-- ─── Images: generated by Wingman or sent in by the user ────────────
-- The file lives in config.media.dir as <id>.<ext> and is served publicly at
-- /media/<id>.<ext> (the id is a random UUID). Kept so "post that image" works
-- in a later message — chat history is text-only.
CREATE TABLE IF NOT EXISTS user_media (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- 'generated' | 'uploaded'
  ext TEXT NOT NULL DEFAULT 'jpg',
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes INTEGER NOT NULL DEFAULT 0,
  note TEXT,                          -- prompt (generated) or caption (uploaded)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_media_user ON user_media(user_id, created_at);

-- ─── What Wingman understands about each connected app ──────────────
-- One row per (user, app). `note` is Wingman's own summary of what it found in
-- the app (never raw data). Studied right after connecting, deepened over the
-- first week (runs 1..4), then refreshed weekly. Injected into every chat.
CREATE TABLE IF NOT EXISTS app_knowledge (
  user_id TEXT NOT NULL,
  app TEXT NOT NULL,                     -- 'shopify', 'slack', 'facebook', …
  note TEXT,
  status TEXT NOT NULL DEFAULT 'new',    -- new | learning | ready | failed
  runs INTEGER NOT NULL DEFAULT 0,
  announced INTEGER DEFAULT 0,           -- 1 = user was told we're studying it (a fresh connect)
  connected_at TEXT DEFAULT (datetime('now')),
  studied_at TEXT,
  next_study_at TEXT,
  last_error TEXT,
  PRIMARY KEY (user_id, app)
);

-- ─── The user's standing rules for how Wingman should behave ────────
--   auto_approve  — "don't ask me for this": a specific app tool may run
--                   without the usual yes (server-enforced, never for risky tools)
--   always_ask    — "always check with me before …"
--   notify_mute   — "don't tell me about …"
--   notify_always — "always tell me about …"
CREATE TABLE IF NOT EXISTS user_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  toolkit TEXT,
  tool_slug TEXT,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_rules_user ON user_rules(user_id, kind);

-- ─── Search index over everything Wingman has synced for a user ─────
-- One row per searchable item (an email summary, a meeting, an event, a task,
-- a contact, a follow-up, a chat message), kept in step with its source table by
-- services/userIndex.js. search_fts is a full-text index over it (SQLite FTS5,
-- built into better-sqlite3), so "what did the client say last month" is a local
-- query, not a live API call.
CREATE TABLE IF NOT EXISTS search_docs (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,          -- email | meeting | event | task | contact | followup | chat
  ref_id TEXT NOT NULL,          -- id in the source table
  at TEXT,                       -- when it happened (ISO / SQLite UTC)
  title TEXT,
  body TEXT,
  UNIQUE (source, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_search_docs_user ON search_docs(user_id, source, at);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body, content='search_docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
-- How far each source has been indexed (by rowid of the source table).
CREATE TABLE IF NOT EXISTS search_state (
  source TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);


-- ─── Messages held while the user is outside WhatsApp's 24h window ──
-- A free-form message outside the window is accepted by Meta and then silently
-- dropped. So a proactive message that can't go out as-is is held here (one
-- short template tells the user something is waiting) and delivered in full,
-- in order, the next time they message Wingman.
CREATE TABLE IF NOT EXISTS held_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_held_messages_user ON held_messages(user_id, id);

-- ─── Inbound WhatsApp message ids already processed ──────────────────
-- Meta retries webhooks; without this a retried message runs the engine twice.
CREATE TABLE IF NOT EXISTS inbound_seen (
  wa_message_id TEXT PRIMARY KEY,
  seen_at TEXT DEFAULT (datetime('now'))
);

-- ─── Briefing / wrap calls (ElevenLabs agent over WhatsApp) ─────────
-- One row per call. The scheduler polls ElevenLabs for the outcome; a call
-- that wasn't answered falls back to the text briefing + a voice note.
CREATE TABLE IF NOT EXISTS voice_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'briefing' | 'wrap' | 'inbound'
  conversation_id TEXT,
  call_token TEXT NOT NULL,            -- lets the agent's tool calls identify the user
  status TEXT NOT NULL DEFAULT 'calling', -- calling | live (inbound) | answered | missed | failed | ended
  briefing_text TEXT,
  duration_secs INTEGER,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_user ON voice_calls(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_calls_token ON voice_calls(call_token);
