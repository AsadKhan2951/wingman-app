'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('../config');

// Ensure the ./data directory exists before opening the DB file
const dbDir = path.dirname(config.database.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.database.path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait (don't error) when another process holds the write lock. Critical for the
// WhatsApp send-dedup guard: if two instances briefly overlap (e.g. during a
// redeploy) their INSERT OR IGNORE must SERIALIZE, not hit SQLITE_BUSY — a busy
// error there would let a duplicate message slip through.
db.pragma('busy_timeout = 8000');

/**
 * Apply the schema (idempotent — uses CREATE TABLE IF NOT EXISTS).
 */
function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  try {
    db.exec(schema);
  } catch (e) {
    // Existing databases can be older than the current schema. If the schema
    // file now contains an index over columns that do not exist yet, SQLite
    // aborts here before additive migrations run. Continue and let the
    // migration/index step below bring the DB forward safely.
    if (String(e && e.message || '').includes('no such column:')) {
      console.warn('[db] schema apply deferred to additive migrations:', e.message);
    } else {
      throw e;
    }
  }
  applyMigrations();
  // Move any pre-multi-account Google connection into google_accounts. Required
  // after the tables exist, and safe to run on every boot (it is a no-op once done).
  try { require('./googleAccounts').migrateLegacyTokens(); }
  catch (e) { console.warn('[db] google account migration skipped:', e.message); }
  console.log('[db] Schema initialized at', config.database.path);
}

/**
 * Additive migrations for columns added after a DB was first created.
 * `CREATE TABLE IF NOT EXISTS` never alters existing tables, so we add any
 * missing columns here. Safe to run on every startup.
 */
function applyMigrations() {
  const additions = {
    // 1 = the user connected this app themselves just now and was told Wingman is
    // studying it; 0 = studied quietly (it was already connected), so stay quiet.
    app_knowledge: [
      ['announced', 'INTEGER DEFAULT 0'],
    ],
    otp_codes: [
      ['ref', 'TEXT'],
      ['poll_secret', 'TEXT'],
      ['confirmed', 'INTEGER DEFAULT 0'],
      ['ip', 'TEXT'],
    ],
    travel: [
      ['return_time', 'TEXT'],
      ['hotel_name', 'TEXT'],
      ['hotel_checkin', 'TEXT'],
      ['hotel_checkout', 'TEXT'],
      ["metadata", "TEXT DEFAULT '{}'"],
    ],
    contacts: [
      ['interaction_count', 'INTEGER DEFAULT 0'],
      ['strength', 'TEXT'],
    ],
    users: [
      ['onboarding_complete', 'INTEGER DEFAULT 0'],
      ["briefing_time", "TEXT DEFAULT '07:00'"],
      ["debrief_time", "TEXT DEFAULT '20:00'"],
      ["proactiveness_level", "TEXT DEFAULT 'moderate'"],
      ["enabled_skills", "TEXT DEFAULT '[\"travel_assistant\",\"bill_tracker\",\"delivery_tracker\",\"people_crm\",\"followup_tracker\"]'"],
      ["tone", "TEXT DEFAULT 'friendly'"],
      ["communication_style", "TEXT DEFAULT 'concise'"],
      ['shopify_domain', 'TEXT'],
      ['shopify_token', 'TEXT'],
['voice_replies', 'TEXT'],
      ['voice_name', 'TEXT'],
      ['assistant_name', 'TEXT'],
      ['health_token', 'TEXT'],
      ['work_token', 'TEXT'],
      ['google_health_token', 'TEXT'],
      ['google_health_synced_at', 'TEXT'],
      ['current_lat', 'REAL'],
      ['current_lng', 'REAL'],
      ['current_location_at', 'TEXT'],
      ['current_location_label', 'TEXT'],
      ['work_action_url', 'TEXT'],
      ['work_action_secret_enc', 'TEXT'],
      ['work_employee_ref', 'TEXT'],
      ['webmail_address','TEXT'],
      ['webmail_password_enc','TEXT'],
      ['webmail_imap_host','TEXT'],
      ['webmail_imap_port','INTEGER'],
      ['webmail_smtp_host','TEXT'],
      ['webmail_smtp_port','INTEGER'],
      ['webmail_from_name','TEXT'],
      ['home_address', 'TEXT'],
      ['home_lat', 'REAL'],
      ['home_lng', 'REAL'],
      ['office_address', 'TEXT'],
      ['office_lat', 'REAL'],
      ['office_lng', 'REAL'],
      ['news_topics', 'TEXT'],
      ['news_city', 'TEXT'],
      ['news_country', 'TEXT'],
      // Onboarding preferences that previously had nowhere to land, so the AI
      // never knew them: how much it may act unprompted, when to stay quiet,
      // and whether the user runs a business.
      ['autonomy_level', 'TEXT'],
      ['quiet_hours_start', 'TEXT'],
      ['quiet_hours_end', 'TEXT'],
      ['runs_business', 'INTEGER DEFAULT 1'],
      ['avatar_url', 'TEXT'],
    ],
    tasks: [
      ['completed_at', 'TEXT'],
      ['google_task_id', 'TEXT'],
      ['google_tasklist_id', 'TEXT'],
      ['google_account_id', 'TEXT'],
      ['google_updated_at', 'TEXT'],
      ["sync_state", "TEXT DEFAULT 'local_only'"],
      // SQLite rejects ADD COLUMN with CURRENT_TIMESTAMP on older existing
      // tables, so we add this one without a default and backfill below.
      ['updated_at', 'TEXT'],
    ],
    email_items: [
      ['account_id', 'TEXT'],
      ['account_email', 'TEXT'],
      // When the email actually ARRIVED (created_at is when Wingman processed it).
      ['received_at', 'TEXT'],
    ],
    meetings: [
      ['recording_url', 'TEXT'],
      ['tasks_created', 'INTEGER DEFAULT 0'],
    ],
    calendar_events: [
      // (This key used to appear twice in this object, so the second copy
      // silently replaced the first and account_id/account_email were never
      // added to older databases. One entry now.)
      ['account_id', 'TEXT'],
      ['account_email', 'TEXT'],
      // The Meet/Zoom/Teams join link (+ which provider), so the notetaker bot
      // knows where to go. Older caches predate these columns.
      ['meeting_url', 'TEXT'],
      ['meeting_provider', 'TEXT'],
    ],
    meeting_bots: [
      // Recall.ai bot id, when Recall drives the join instead of the self-host worker.
      ['recall_bot_id', 'TEXT'],
    ],
    bills: [
      // When we last alerted about this bill, so overdue bills don't re-notify daily.
      ['last_alerted_at', 'TEXT'],
      // How many times we've nudged about it — capped so a still-unpaid bill
      // isn't chased forever (the "old bills keep pinging" complaint).
      ['reminder_count', 'INTEGER DEFAULT 0'],
      // When the bill was actually marked paid — lets the behaviour layer learn
      // whether this user pays early / on time / late, so reminders fire at the
      // lead time that actually works for them. No backfill (old paid bills have
      // no timestamp); it accumulates from here.
      ['paid_at', 'TEXT'],
    ],
    automations: [
      // Anchor a fire time to a learned behaviour (e.g. the user's usual finish),
      // so the reminder self-adjusts as that behaviour drifts. Null → fixed time.
      ['anchor', 'TEXT'],
      ['lead_minutes', 'INTEGER'],
    ],
  };
  for (const [table, cols] of Object.entries(additions)) {
    let existing;
    try {
      existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    } catch (_) { continue; }
    for (const [name, def] of cols) {
      if (!existing.has(name)) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`); }
        catch (e) { /* ignore if already present */ }
      }
    }
  }

  try {
    const taskCols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name));
    if (taskCols.has('updated_at')) {
      db.exec("UPDATE tasks SET updated_at = COALESCE(updated_at, created_at, datetime('now'))");
    }
  } catch (_) { /* ignore */ }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_google_ref ON tasks(user_id, google_account_id, google_tasklist_id, google_task_id)');
  } catch (_) { /* ignore */ }
}

/**
 * Convenience UUID generator.
 */
function uuid() {
  return crypto.randomUUID();
}

module.exports = { db, initSchema, uuid };
