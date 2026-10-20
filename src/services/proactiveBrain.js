'use strict';

const claude = require('../llm/claude');
const usersRepo = require('../db/users');
const t = require('../utils/time');
const memoryRepo = require('../db/userMemory');

/**
 * The proactive brain — the difference between a data screen and an assistant.
 *
 * Every other proactive feature is a single rule watching a single thing (a bill
 * near its date, a health reading off its baseline). This looks at EVERYTHING
 * Wingman holds about a person at once and reasons like a chief of staff: what,
 * across all of it, genuinely needs them right now? It connects dots a
 * single-domain rule can't — "you promised Ali the deck AND you have back-to-back
 * meetings till 5, so do it now" — and, just as importantly, says nothing when
 * nothing is worth interrupting them for.
 *
 * Two guards keep it useful rather than noisy:
 *   1. It only calls the model when the cheap local snapshot already contains
 *      something time-sensitive — quiet days cost nothing and stay silent.
 *   2. It never repeats an insight it already sent the same day.
 */

// ── Snapshot: cheap, local reads only ────────────────────────────────
//   Everything here is SQLite. No IMAP/Shopify/Google calls — those are the
//   sync services' job; the brain reasons over what they've already cached.

function req(name) { try { return require(`../db/${name}`); } catch (_) { return null; } }
function svc(name) { try { return require(`./${name}`); } catch (_) { return null; } }

function daysUntil(dateStr, tz, now) {
  if (!dateStr) return null;
  const today = t.dateKeyInTz(tz, now);
  // dateStr may be 'YYYY-MM-DD' or an ISO datetime.
  const d = String(dateStr).slice(0, 10);
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Build the snapshot AND flag whether anything is time-sensitive enough to be
 * worth the model's attention. `signals` is what makes the cut; `context` is
 * supporting colour the model can use but which wouldn't fire it on its own.
 */
function snapshot(user, now = new Date()) {
  const tz = user.timezone || 'Asia/Karachi';
  const uid = user.id;
  const signals = [];
  const context = [];

  // Calendar — today's remaining meetings.
  const cal = req('calendarEvents');
  if (cal && cal.listStartingBetween) {
    const from = now.toISOString();
    const to = t.startOfDayISO(tz, 1, now);
    const today = cal.listStartingBetween(uid, from, to) || [];
    if (today.length) {
      context.push(`Meetings left today: ${today.slice(0, 5).map((e) => `${t.timeLabel(e.start_time, tz)} ${e.title || 'event'}`).join(', ')}`);
    }
  }

  // Bills — overdue or due within 2 days is a signal.
  const bills = req('bills');
  if (bills && bills.listForUser) {
    for (const b of bills.listForUser(uid, { status: 'pending' }) || []) {
      const d = daysUntil(b.due_date, tz, now);
      if (d == null) continue;
      if (d < 0) signals.push(`OVERDUE bill: ${b.name} (${b.currency || ''} ${b.amount || ''}) was due ${-d} day(s) ago`);
      else if (d <= 2) signals.push(`Bill due ${d === 0 ? 'TODAY' : `in ${d} day(s)`}: ${b.name} (${b.currency || ''} ${b.amount || ''})`);
    }
  }

  // Tasks — overdue, or due today.
  const tasks = req('tasks');
  if (tasks) {
    try {
      for (const task of (tasks.listOverdue ? tasks.listOverdue(uid, now.toISOString()) : []) || []) {
        signals.push(`Overdue task: ${task.title}`);
      }
      const dayEnd = t.startOfDayISO(tz, 1, now);
      for (const task of (tasks.listDueBetween ? tasks.listDueBetween(uid, now.toISOString(), dayEnd) : []) || []) {
        signals.push(`Task due today: ${task.title}`);
      }
    } catch (_) { /* tasks optional */ }
  }

  // Promises the user made and hasn't closed.
  const followups = req('followups');
  if (followups && followups.listOpen) {
    for (const f of followups.listOpen(uid) || []) {
      if (f.type === 'promise_made') signals.push(`Open promise: you said you'd ${f.description}`);
      // Someone owes them something from a meeting and it's been 2+ days.
      else if (f.type === 'promise_received' && /\(from "/.test(f.description || '')
        && f.created_at && now - Date.parse(String(f.created_at).replace(' ', 'T') + 'Z') > 2 * 86400e3) {
        context.push(`${f.counterparty || 'Someone'} still owes: ${f.description} — offer to nudge them`);
      }
    }
  }

  // Meetings that ended with points still open and a follow-up nobody booked.
  try {
    for (const p of require('./meetingFollowup').listPending(uid, now)) {
      if (now - Date.parse(String(p.created_at).replace(' ', 'T') + 'Z') > 20 * 3600e3) {
        signals.push(`Unbooked meeting follow-up "${p.title}" — still open: ${p.items.join('; ')} (followup_id ${p.id}). Offer to book it.`);
      }
    }
  } catch (_) { /* optional */ }

  // Health — the analyst's own flags.
  const health = svc('health');
  if (health) {
    try {
      const flags = health.findAnomalies(uid) || [];
      for (const a of flags) signals.push(`Health: ${a.label} ${a.direction} than usual (${a.value}${a.unit} vs ~${a.baseline}${a.unit})`);
      const line = health.summaryLine(uid);
      if (line && !flags.length) context.push(`Health looks normal (${line})`);
    } catch (_) { /* health optional */ }
  }

  // Work clock — still on the clock well past their day is a signal.
  const work = svc('work');
  if (work) {
    try {
      const st = work.status(uid, { now });
      if (st.connected && st.clocked_in) {
        const overBy = st.on_clock_for || '';
        context.push(`On the clock since ${st.since} (${overBy} so far)`);
      }
    } catch (_) { /* work optional */ }
  }

  // Business mail waiting (from the last notification sweep, not a live fetch).
  const prefs = user.preferences || {};
  if (prefs.webmailUnseen) context.push(`${prefs.webmailUnseen} customer email(s) may be waiting`);

  return { tz, signals, context, hasSignals: signals.length > 0 };
}

function policyFor(user) {
  return [
    `Name: ${user.name || 'User'}`,
    `Timezone: ${user.timezone || 'Asia/Karachi'}`,
    `Work hours: ${user.work_hours_start || '?'}-${user.work_hours_end || '?'}`,
    `Tone: ${user.tone || 'friendly'}`,
    `Style: ${user.communication_style || 'concise'}`,
    `Proactiveness: ${user.proactiveness_level || 'high'}`,
  ].join('\n');
}

function memoryBlock(userId) {
  const facts = memoryRepo.listForUser(userId, 10);
  if (!facts.length) return '';
  return facts.map((f) => `- (${f.category}) ${f.fact}`).join('\n');
}

// ── The think pass ───────────────────────────────────────────────────

const SYSTEM = `You are the user's sharp, trusted chief of staff, messaging them on WhatsApp. You see their whole picture — calendar, tasks, bills, promises they've made, health, work hours, customer mail — and your job is to flag what genuinely needs them RIGHT NOW, and connect things a single reminder would miss.

Return ONLY a compact JSON array of short strings, each a single ready-to-send nudge. Return [] when nothing is worth interrupting them — that is the correct, common answer.

Hard rules:
- Only use facts from the snapshot given. Never invent a bill, task, meeting or number.
- Each nudge is ONE short WhatsApp line, warm and specific: what it is, why it matters now, and the action. A little emoji is fine.
- Prioritise ruthlessly: at most the top 3, usually 1. A time-critical bill or a promise beats a routine note.
- Connect dots when the data supports it ("you're in meetings till 5 and that bill is due today — pay it now before you forget"). Don't force a connection that isn't there.
- Do NOT restate the morning briefing or nag about things that aren't time-sensitive. If it can wait, leave it out.
- Never diagnose health or give medical advice; a health item here is just "worth easing off today".`;

function parseInsights(raw) {
  if (!raw) return [];
  const text = String(raw).replace(/```json|```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.map((s) => String(s || '').trim()).filter(Boolean) : [];
  } catch (_) { return []; }
}

/** A stable-ish key so we don't repeat the same nudge within a day. */
function keyOf(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
}

/**
 * Produce the insights worth sending this user right now (deduped against what
 * was already sent today). Returns [] on a quiet day or any failure.
 */
async function think(userId, { now = new Date() } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { insights: [], skipped: 'no_user' };

  const snap = snapshot(user, now);
  // The cheap guard: no time-sensitive signal → no model call, no message.
  if (!snap.hasSignals) return { insights: [], skipped: 'quiet' };

  const memories = memoryBlock(userId);
  let behaviour = '';
  try {
    const b = require('./behaviorPatterns').computeForUser(userId, { now });
    if (b.lines.length) behaviour = b.lines.join('\n');
  } catch (_) { /* behaviour layer optional */ }

  const prompt = `USER POLICY:\n${policyFor(user)}\n\n` +
    (memories ? `WHAT YOU ALREADY KNOW ABOUT THEM:\n${memories}\n\n` : '') +
    (behaviour ? `HOW THEY ACTUALLY BEHAVE (observed — use it to time and pitch the nudge):\n${behaviour}\n\n` : '') +
    `Here is everything about ${user.name || 'the user'} right now.\n\n` +
    `NEEDS ATTENTION:\n${snap.signals.map((s) => `- ${s}`).join('\n')}\n\n` +
    (snap.context.length ? `CONTEXT (use only if it helps connect dots):\n${snap.context.map((c) => `- ${c}`).join('\n')}\n\n` : '') +
    `What, if anything, should you tell them right now?`;

  let insights;
  try {
    insights = parseInsights(await claude.complete(prompt, { system: SYSTEM, maxTokens: 400, model: require('../config').anthropic.modelDeep }));
  } catch (err) {
    console.warn('[proactiveBrain] think failed:', err.message);
    return { insights: [], skipped: 'llm_error' };
  }
  if (!insights.length) return { insights: [], skipped: 'nothing_worth_saying' };

  // Drop anything already said today.
  const tz = snap.tz;
  const dayKey = t.dateKeyInTz(tz, now);
  const prefs = user.preferences || {};
  const sentToday = (prefs.brainSent && prefs.brainSent.day === dayKey) ? prefs.brainSent.keys : [];
  const fresh = insights.filter((i) => !sentToday.includes(keyOf(i))).slice(0, 3);

  return { insights: fresh, dayKey, sentToday };
}

/** Think, then send. Window-aware; records what was said to avoid repeats. */
async function runForUser(userId, { now = new Date(), send = true } = {}) {
  const gate = require('./proactiveGate');
  const user = usersRepo.getById(userId);
  if (!user || !gate.allows(user, 'brain')) return { sent: null, skipped: 'gated' };

  const { insights, dayKey, sentToday, skipped } = await think(userId, { now });
  if (!insights || !insights.length) return { sent: null, skipped: skipped || 'nothing' };

  const msg = insights.length === 1 ? insights[0] : insights.map((i) => `• ${i}`).join('\n');

  if (send) {
    const wa = require('../whatsapp/client');
    if (wa.ready()) {
      try { await wa.sendProactiveMessage(user, msg, { now, logLabel: 'brain' }); }
      catch (err) { console.warn('[proactiveBrain] send failed:', err.message); }
    } else {
      console.log('[proactiveBrain] (WA not ready) would nudge:', user.phone);
    }
  }

  // Remember, so we don't repeat these today.
  const fresh = usersRepo.getById(userId) || user;
  const prefs = fresh.preferences || {};
  const keys = (prefs.brainSent && prefs.brainSent.day === dayKey ? prefs.brainSent.keys : (sentToday || []))
    .concat(insights.map(keyOf));
  prefs.brainSent = { day: dayKey, keys: keys.slice(-20) };
  usersRepo.update(userId, { preferences: prefs });

  return { sent: msg, count: insights.length };
}

/**
 * Sweep at a sensible local hour. Runs twice a day (late morning, late
 * afternoon) so a "due today" thing is caught while there's still time to act.
 */
async function runDueUsers({ now = new Date(), hours = [11, 17], windowMin = 60 } = {}) {
  const gate = require('./proactiveGate');
  const users = gate.eligibleUsers('brain');
  const results = [];
  for (const u of users) {
    const tz = u.timezone || 'Asia/Karachi';
    const localHour = t.hourInTz(tz, now);
    if (!hours.includes(localHour)) continue;
    // Once per (user, hour-slot) — the tick runs every 15 min within the hour.
    const dayKey = t.dateKeyInTz(tz, now);
    const slotKey = `${dayKey}:${localHour}`;
    if (((u.preferences || {}).brainSlot) === slotKey) continue;
    usersRepo.updatePreferences(u.id, { brainSlot: slotKey });

    try {
      const r = await runForUser(u.id, { now });
      if (r.sent) results.push({ phone: u.phone, count: r.count });
    } catch (err) {
      console.warn('[proactiveBrain] failed for', u.phone, err.message);
    }
  }
  if (results.length) console.log('[proactiveBrain] nudged', results.length, 'user(s)');
  return results;
}

module.exports = { snapshot, think, runForUser, runDueUsers, parseInsights };
