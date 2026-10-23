'use strict';

/**
 * The chief-of-staff day: the briefing and the wrap stop being reports and say
 * what Wingman is HANDLING and what needs the user's yes.
 *
 *   morningPlan(user) — "On it today" (what Wingman takes care of) +
 *                       "Needs your yes" (drafted replies, meeting follow-ups,
 *                       waiting actions, overdue tasks).
 *   eveningReport(user) — "Done for you today" (from the audit trail) +
 *                         "Still waiting on you" + "Others owe you".
 *
 * Every line is backed by real data — it never claims work that didn't happen.
 * Roman Urdu for users who talk that way.
 */

const { db } = require('../db');
const t = require('../utils/time');

function speaksUrdu(user) {
  // From how they actually write — never from where they live.
  return /urdu/.test(require('../utils/language').userLanguage(user));
}

const fromName = (s) => String(s || '').replace(/\s*<.*>/, '').replace(/"/g, '').trim() || String(s || '');
const clip = (s, n = 60) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const sqlTime = (iso) => String(iso).replace('T', ' ').slice(0, 19);

function L(user) {
  const ur = speaksUrdu(user);
  return {
    onIt: ur ? '🧭 *Aaj main sambhal raha hoon:*' : '🧭 *On it today:*',
    needsYes: ur ? '✋ *Tumhara haan chahiye:*' : '✋ *Needs your yes:*',
    prep: (n) => (ur ? `Aaj ki ${n} meeting${n === 1 ? '' : 's'} se pehle prep notes` : `Prep notes before your ${n} meeting${n === 1 ? '' : 's'} today`),
    drafted: (n) => (ur ? `${n} email${n === 1 ? '' : 's'} ke jawab tumhare andaaz mein tayyar` : `${n} repl${n === 1 ? 'y' : 'ies'} drafted in your voice`),
    watching: (n, ex) => (ur ? `${n} cheez${n === 1 ? '' : 'en'} jo log tumhe dene wale hain — nazar rakh raha hoon${ex ? ` (${ex})` : ''}` : `Keeping an eye on ${n} thing${n === 1 ? '' : 's'} people owe you${ex ? ` (${ex})` : ''}`),
    auto: (s) => (ur ? `Bina pooche: ${s}` : `Handling without asking: ${s}`),
    reply: (r) => `${ur ? 'Jawab' : 'Reply'} → ${fromName(r.sender)}: "${clip(r.subject, 45)}"${r.prepared_note ? ` — ${ur ? 'chahiye' : 'needs'}: ${clip(r.prepared_note, 50)}` : ''}`,
    followup: (p) => `${ur ? 'Follow-up meeting' : 'Book follow-up'}: ${clip(p.title.replace(/^Follow-up:\s*/, ''), 40)}${(p.attendees || []).length ? ` (${p.attendees.map((a) => String(a.name).split(/\s+/)[0]).join(', ')})` : ''}`,
    action: (a) => `${ur ? 'Intezar mein' : 'Waiting'}: ${clip(a.summary, 70)}`,
    overdue: (n) => (ur ? `${n} kaam overdue` : `${n} overdue task${n === 1 ? '' : 's'}`),
    showReplies: ur ? '"Jawab dikhao" bolo, main ek ek kar ke dikha deta hoon.' : 'Say "show replies" and I\'ll walk you through them.',
    done: ur ? '✅ *Aaj main ne kiya:*' : '✅ *Done for you today:*',
    waiting: ur ? '⏳ *Abhi tumhare jawab ke intezar mein:*' : '⏳ *Still waiting on you:*',
    owed: ur ? '📌 *Log tumhe ye dene wale hain:*' : '📌 *Others still owe you:*',
    moreN: (n) => (ur ? `…aur ${n}` : `…and ${n} more`),
  };
}

function preparedReplies(userId) {
  return db.prepare('SELECT * FROM email_items WHERE user_id = ? AND prepared_reply IS NOT NULL AND replied = 0 ORDER BY COALESCE(received_at, created_at) DESC LIMIT 10').all(userId);
}

function pendingFollowups(userId, now) {
  try { return require('./meetingFollowup').listPending(userId, now); } catch (_) { return []; }
}

function pendingActions(userId) {
  try { return db.prepare("SELECT summary FROM integration_actions WHERE user_id = ? AND status = 'pending' AND created_at >= datetime('now', '-1 day') ORDER BY created_at DESC LIMIT 3").all(userId); } catch (_) { return []; }
}

function owedToThem(userId) {
  return db.prepare("SELECT description, counterparty FROM followups WHERE user_id = ? AND status = 'open' AND type = 'promise_received' ORDER BY COALESCE(due_date, '9999') LIMIT 5").all(userId);
}

/** Lines for the morning briefing. Empty when there is nothing real to say. */
function morningPlan(user, { now = new Date(), eventsToday = null } = {}) {
  const tr = L(user);
  const tz = user.timezone || 'Asia/Karachi';
  const onIt = [];
  const yes = [];

  const events = eventsToday || require('../db/calendarEvents').listStartingBetween(user.id, now.toISOString(), t.startOfDayISO(tz, 1, now));
  if (events.length) onIt.push(tr.prep(events.length));
  const replies = preparedReplies(user.id);
  if (replies.length) onIt.push(tr.drafted(replies.length));
  const owed = owedToThem(user.id);
  if (owed.length) onIt.push(tr.watching(owed.length, owed[0].counterparty ? `${String(owed[0].counterparty).split(/\s+/)[0]} — ${clip(owed[0].description.replace(/\s*\(from ".*"\)$/, ''), 35)}` : ''));
  const grants = db.prepare("SELECT text FROM user_rules WHERE user_id = ? AND kind = 'auto_approve' LIMIT 3").all(user.id).map((r) => r.text);
  if (grants.length) onIt.push(tr.auto(grants.join('; ')));

  for (const r of replies.slice(0, 3)) yes.push(tr.reply(r));
  if (replies.length > 3) yes.push(tr.moreN(replies.length - 3));
  for (const p of pendingFollowups(user.id, now).slice(0, 2)) yes.push(tr.followup(p));
  for (const a of pendingActions(user.id)) yes.push(tr.action(a));
  try {
    const overdue = require('../db/tasks').listOverdue(user.id, now.toISOString()).length;
    if (overdue) yes.push(tr.overdue(overdue));
  } catch (_) { /* optional */ }

  const lines = [];
  if (onIt.length) { lines.push(tr.onIt); for (const x of onIt) lines.push(`• ${x}`); lines.push(''); }
  if (yes.length) {
    lines.push(tr.needsYes);
    for (const x of yes) lines.push(`• ${x}`);
    if (replies.length) lines.push(tr.showReplies);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Lines for the evening wrap. */
function eveningReport(user, { now = new Date() } = {}) {
  const tr = L(user);
  const tz = user.timezone || 'Asia/Karachi';
  const since = sqlTime(new Date(Date.parse(t.startOfDayISO(tz, 0, now))).toISOString());
  const lines = [];

  const did = db.prepare(`SELECT summary FROM agent_actions WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC`).all(user.id, since)
    .map((r) => clip(r.summary.replace(/^\(without asking\)\s*/, '⚡ '), 80));
  const booked = db.prepare("SELECT title FROM meeting_followups WHERE user_id = ? AND status = 'scheduled' AND updated_at >= ?").all(user.id, since);
  for (const b of booked) did.push(clip(b.title, 70));
  if (did.length) {
    lines.push(tr.done);
    for (const d of did.slice(0, 6)) lines.push(`• ${d}`);
    if (did.length > 6) lines.push(tr.moreN(did.length - 6));
    lines.push('');
  }

  const waiting = db.prepare(`SELECT sender, subject, prepared_reply, prepared_note FROM email_items WHERE user_id = ? AND replied = 0
      AND (category IN ('urgent','needs_reply')) AND COALESCE(received_at, created_at) >= datetime('now', '-3 days')
      AND COALESCE(prepared_note, '') <> 'no reply needed'
      ORDER BY COALESCE(received_at, created_at) DESC LIMIT 12`).all(user.id)
    .filter((w) => !require('./replyDrafter').NO_REPLY.test(String(w.sender || '')));
  const fus = pendingFollowups(user.id, now);
  if (waiting.length || fus.length) {
    lines.push(tr.waiting);
    for (const w of waiting.slice(0, 4)) lines.push(`• ${w.prepared_reply ? tr.reply(w) : `${fromName(w.sender)}: "${clip(w.subject, 45)}"`}`);
    for (const p of fus.slice(0, 2)) lines.push(`• ${tr.followup(p)}`);
    lines.push('');
  }

  const owed = owedToThem(user.id);
  if (owed.length) {
    lines.push(tr.owed);
    for (const o of owed.slice(0, 3)) lines.push(`• ${o.counterparty ? `${String(o.counterparty).split(/\s+/)[0]}: ` : ''}${clip(o.description, 60)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

module.exports = { morningPlan, eveningReport, speaksUrdu };
