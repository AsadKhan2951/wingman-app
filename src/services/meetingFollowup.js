'use strict';

/**
 * The meeting follow-up agent — what a chief of staff does after a meeting.
 *
 * Notes alone aren't enough. When a meeting ends with agenda points still open
 * (or topics that clearly need another conversation), this:
 *   1. works out WHAT is still open (agenda from the calendar invite vs. what
 *      was actually discussed — see meetingNotes "agenda"/"unresolved"),
 *   2. works out WHO needs to be there (meeting attendees, resolved against the
 *      user's contacts for names / phones),
 *   3. finds a slot the user is free in their work hours,
 *   4. proposes it on WhatsApp ("Pricing wasn't closed — set a 30-min follow-up
 *      with Ali and Sara on Thu 3 PM and send the invites?"),
 *   5. on the user's yes, books it on their Google Calendar with everyone
 *      invited (Google emails the invites) and the open items as the agenda.
 * Action items owned by OTHER people become follow-ups, so Wingman chases them.
 */

const { db, uuid } = require('../db');
const usersRepo = require('../db/users');
const t = require('../utils/time');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_MINUTES = 30;
const PENDING_DAYS = 7;

// ── Storage ──────────────────────────────────────────────────────────

function hydrate(row) {
  if (!row) return null;
  const j = (v) => { try { return JSON.parse(v || '[]'); } catch (_) { return []; } };
  return { ...row, items: j(row.items), attendees: j(row.attendees) };
}

function getForUser(userId, id) {
  return hydrate(db.prepare('SELECT * FROM meeting_followups WHERE id = ? AND user_id = ?').get(id, userId));
}

function forMeeting(userId, meetingId) {
  return hydrate(db.prepare('SELECT * FROM meeting_followups WHERE user_id = ? AND meeting_id = ? ORDER BY created_at DESC LIMIT 1').get(userId, meetingId));
}

function listPending(userId, now = new Date()) {
  const since = new Date(now.getTime() - PENDING_DAYS * 86400e3).toISOString();
  return db.prepare("SELECT * FROM meeting_followups WHERE user_id = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC")
    .all(userId, since.replace('T', ' ').slice(0, 19)).map(hydrate);
}

function setStatus(userId, id, patch) {
  const cur = getForUser(userId, id);
  if (!cur) return null;
  db.prepare(`UPDATE meeting_followups SET status = ?, event_id = ?, scheduled_start = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(patch.status || cur.status, patch.eventId || cur.event_id || null, patch.scheduledStart || cur.scheduled_start || null, id, userId);
  return getForUser(userId, id);
}

// ── Agenda (from the calendar invite) ────────────────────────────────

function cleanAgenda(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    // Drop the video-call boilerplate Google / Zoom / Teams paste into invites.
    .split('\n')
    .filter((l) => !/(meet\.google\.com|zoom\.us|teams\.microsoft\.com|join with google meet|join by phone|more phone numbers|^-::~|invitation from google calendar|learn more about meet)/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

/** The agenda the user wrote in the meeting's calendar invite, if any. */
function findAgenda(userId, meeting) {
  try {
    const bot = db.prepare('SELECT gcal_event_id FROM meeting_bots WHERE user_id = ? AND meeting_id = ? AND gcal_event_id IS NOT NULL ORDER BY created_at DESC LIMIT 1')
      .get(userId, meeting.id);
    let ev = bot ? require('../db/calendarEvents').findByGcalId(userId, bot.gcal_event_id) : null;
    if (!ev && meeting.meeting_at) {
      const at = Date.parse(meeting.meeting_at);
      const rows = db.prepare('SELECT * FROM calendar_events WHERE user_id = ? AND start_time IS NOT NULL').all(userId);
      const title = String(meeting.title || '').toLowerCase().trim();
      ev = rows.find((r) => Math.abs(Date.parse(r.start_time) - at) <= 45 * 60e3
        && (!title || String(r.title || '').toLowerCase().trim() === title)) || null;
    }
    return ev ? cleanAgenda(ev.description) : '';
  } catch (_) {
    return '';
  }
}

// ── Who ──────────────────────────────────────────────────────────────

function ownEmails(user) {
  const out = new Set();
  try { for (const a of require('../db/googleAccounts').listForUser(user.id)) if (a.email) out.add(String(a.email).toLowerCase()); } catch (_) { /* none */ }
  if (user.webmail_address) out.add(String(user.webmail_address).toLowerCase());
  if (user.email) out.add(String(user.email).toLowerCase());
  return out;
}

function contactByEmail(userId, email) {
  try { return db.prepare('SELECT name, phone, email FROM contacts WHERE user_id = ? AND LOWER(email) = ? LIMIT 1').get(userId, email); } catch (_) { return null; }
}

/** The other people from the meeting: [{ name, email, phone }]. */
function peopleFor(user, meeting) {
  const mine = ownEmails(user);
  const seen = new Set();
  const out = [];
  for (const a of meeting.attendees || []) {
    const email = String((a && a.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || mine.has(email) || seen.has(email)) continue;
    if (/(resource\.calendar\.google\.com|notetaker|wingman|recall\.ai|@group\.calendar)/i.test(email)) continue;
    seen.add(email);
    const c = contactByEmail(user.id, email);
    out.push({ name: (a && a.name) || (c && c.name) || email.split('@')[0], email, phone: (c && c.phone) || null });
  }
  return out;
}

// ── When ─────────────────────────────────────────────────────────────

/** First free slot in the user's work hours, from tomorrow, skipping weekends. */
function suggestSlot(user, { minutes = DEFAULT_MINUTES, now = new Date(), days = 10 } = {}) {
  const tz = user.timezone || 'Asia/Karachi';
  const startMin = t.parseHhMm(user.work_hours_start) ?? 10 * 60;
  const endMin = t.parseHhMm(user.work_hours_end) ?? 18 * 60;
  const busy = db.prepare('SELECT start_time, end_time, all_day FROM calendar_events WHERE user_id = ? AND start_time IS NOT NULL').all(user.id)
    .filter((e) => !e.all_day)
    .map((e) => [Date.parse(e.start_time), Date.parse(e.end_time || e.start_time)])
    .filter(([a, b]) => !Number.isNaN(a) && !Number.isNaN(b));
  for (let d = 1; d <= days; d += 1) {
    const dayStart = Date.parse(t.startOfDayISO(tz, d, now));
    if (Number.isNaN(dayStart)) continue;
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(dayStart + 12 * 3600e3));
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    // Not the first minutes of the day: start an hour in, so it isn't 9:00 sharp.
    for (let m = Math.min(startMin + 60, endMin - minutes); m + minutes <= endMin; m += 30) {
      const a = dayStart + m * 60e3;
      const b = a + minutes * 60e3;
      if (!busy.some(([s, e]) => s < b && e > a)) return new Date(a).toISOString();
    }
  }
  return null;
}

// ── Plan ─────────────────────────────────────────────────────────────

function openItems(summary) {
  const s = summary || {};
  const items = [];
  for (const a of s.agenda || []) {
    if (a.status === 'partial' || a.status === 'not_discussed') items.push(a.note ? `${a.item} — ${a.note}` : a.item);
  }
  // "unresolved" often restates an open agenda point in other words — skip it
  // when most of its meaningful words are already in an item.
  const words = (x) => String(x).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
  for (const u of s.unresolved || []) {
    const w = words(u);
    const dup = items.some((i) => {
      const have = new Set(words(i));
      return w.length && w.filter((x) => have.has(x)).length / w.length >= 0.5;
    });
    if (!dup) items.push(u);
  }
  return items.slice(0, 6);
}

/** Action items owned by someone else → follow-ups Wingman chases. */
function trackOthersActions(user, meeting, summary) {
  const firstName = String(user.name || '').trim().split(/\s+/)[0].toLowerCase();
  const repo = require('../db/followups');
  let n = 0;
  for (const a of (summary && summary.actions) || []) {
    const owner = String(a.owner || '').trim();
    if (!owner || (firstName && owner.toLowerCase().includes(firstName))) continue;
    try {
      repo.create(user.id, {
        type: 'promise_received',
        description: `${a.task} (from "${meeting.title || 'meeting'}")`.slice(0, 200),
        counterparty: owner,
        dueDate: null,
      });
      n += 1;
    } catch (_) { /* best effort */ }
  }
  return n;
}

/**
 * After a meeting's summary is ready: decide whether a follow-up is needed and
 * store the plan. Returns the plan or null. Never throws.
 */
function prepare(user, meeting, summary, { now = new Date() } = {}) {
  try {
    trackOthersActions(user, meeting, summary);
    const items = openItems(summary);
    if (!items.length) return null;
    const existing = forMeeting(user.id, meeting.id);
    if (existing) return existing;
    const people = peopleFor(user, meeting);
    const start = suggestSlot(user, { now });
    const id = uuid();
    db.prepare(`
      INSERT INTO meeting_followups (id, user_id, meeting_id, title, items, attendees, proposed_start, duration_min, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, user.id, meeting.id, `Follow-up: ${meeting.title || 'meeting'}`.slice(0, 200), JSON.stringify(items), JSON.stringify(people), start, DEFAULT_MINUTES);
    return getForUser(user.id, id);
  } catch (err) {
    console.warn('[meetingFollowup] prepare failed:', err.message);
    return null;
  }
}

function speaksUrdu(user) {
  const p = (user.preferences && user.preferences.styleProfile) || {};
  return /urdu/i.test(String((p.chat && p.chat.language) || '')) || /^ur/i.test(String(user.language || ''));
}

function names(people) {
  const n = people.map((p) => String(p.name).split(/\s+/)[0]);
  if (n.length <= 1) return n.join('');
  return `${n.slice(0, -1).join(', ')} & ${n[n.length - 1]}`;
}

/** The WhatsApp lines added under the meeting notes. */
function proposalText(user, plan) {
  if (!plan || plan.status !== 'pending') return '';
  const tz = user.timezone || 'Asia/Karachi';
  const when = plan.proposed_start ? `${t.dayLabel(plan.proposed_start, tz)} ${t.timeLabel(plan.proposed_start, tz)}` : null;
  const who = names(plan.attendees || []);
  const urdu = speaksUrdu(user);
  const lines = ['', urdu ? '⚠️ *Ye cheezen hal nahi huin:*' : '⚠️ *Still open after this meeting:*'];
  for (const i of plan.items) lines.push(`• ${i}`);
  lines.push('');
  if (urdu) {
    lines.push(`${who ? `${who} ke saath ` : ''}${when ? `*${when}*` : 'agle hafte'} ${plan.duration_min} min ka follow-up rakh doon${who ? ' aur invite bhej doon' : ''}? "Haan" bolo, ya koi aur waqt batao.`);
  } else {
    lines.push(`Want me to set a ${plan.duration_min}-min follow-up${who ? ` with ${who}` : ''}${when ? ` on *${when}*` : ''}${who ? ' and send the invites' : ''}? Say yes, or give me another time.`);
  }
  return lines.join('\n');
}

/** Book it: calendar event with everyone invited + the open items as agenda. */
async function schedule(user, id, { startTime, durationMin, note } = {}) {
  const plan = getForUser(user.id, id);
  if (!plan) return { error: 'FOLLOWUP_NOT_FOUND' };
  if (plan.status === 'scheduled') return { error: 'ALREADY_SCHEDULED', event_id: plan.event_id, start: plan.scheduled_start };
  const start = startTime || plan.proposed_start;
  if (!start || Number.isNaN(Date.parse(start))) return { error: 'NEED_TIME', detail: 'No free slot was found — ask the user when.' };
  const mins = Math.min(Math.max(parseInt(durationMin, 10) || plan.duration_min || DEFAULT_MINUTES, 10), 240);
  const end = new Date(Date.parse(start) + mins * 60e3).toISOString();
  const description = [
    note ? `${note}\n` : null,
    'Open items from the last meeting:',
    ...plan.items.map((i) => `• ${i}`),
    '',
    '— Scheduled by Wingman',
  ].filter((x) => x !== null).join('\n');
  let ev;
  try {
    ev = await require('./calendar').createEvent(user.id, {
      title: plan.title,
      startTime: start,
      endTime: end,
      description,
      attendees: (plan.attendees || []).map((p) => p.email),
      timeZone: user.timezone,
    });
  } catch (err) {
    const gc = require('./googleConnection');
    if (gc.isAuthError(err)) { gc.markBroken(user, { reason: 'calendar' }); return { error: 'GOOGLE_RECONNECT_NEEDED' }; }
    return { error: 'CALENDAR_FAILED', detail: String(err.message || '').slice(0, 200) };
  }
  setStatus(user.id, id, { status: 'scheduled', eventId: ev && (ev.gcalEventId || ev.id), scheduledStart: start });
  const tz = user.timezone || 'Asia/Karachi';
  return {
    scheduled: true,
    title: plan.title,
    when: `${t.dayLabel(start, tz)} ${t.timeLabel(start, tz)}`,
    minutes: mins,
    invited: (plan.attendees || []).map((p) => `${p.name} <${p.email}>`),
    note: (plan.attendees || []).length
      ? 'Google emailed the invite to everyone, with the open items as the agenda.'
      : 'Booked on their calendar (no other attendees had an email address).',
  };
}

function dismiss(user, id) {
  const r = setStatus(user.id, id, { status: 'dismissed' });
  return r ? { dismissed: true } : { error: 'FOLLOWUP_NOT_FOUND' };
}

/** Chat-prompt block so a plain "yes" to the proposal is understood. */
function promptBlock(user, now = new Date()) {
  let rows = [];
  try { rows = listPending(user.id, now); } catch (_) { return ''; }
  if (!rows.length) return '';
  const tz = user.timezone || 'Asia/Karachi';
  const lines = rows.slice(0, 3).map((p) => {
    const when = p.proposed_start ? `${t.dayLabel(p.proposed_start, tz)} ${t.timeLabel(p.proposed_start, tz)}` : 'no free slot found';
    const who = (p.attendees || []).map((a) => a.name).join(', ') || 'no other attendees';
    return `- followup_id ${p.id} · "${p.title}" · open: ${p.items.join(' | ')} · with: ${who} · proposed: ${when}`;
  });
  return `\n\n--- MEETING FOLLOW-UPS YOU PROPOSED (waiting for the user) ---\n${lines.join('\n')}\n`
    + 'If the user agrees ("yes", "haan", "kar do", "theek hai") right after you proposed one, call schedule_meeting_followup with its followup_id. If they give another day/time, pass start_time (ISO with their offset). If they say no / not needed, call dismiss_meeting_followup. Then confirm in one short line who was invited and when.';
}

module.exports = {
  prepare, schedule, dismiss, listPending, getForUser, forMeeting, promptBlock, proposalText,
  findAgenda, cleanAgenda, openItems, peopleFor, suggestSlot, trackOthersActions,
};
