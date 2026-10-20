'use strict';

/**
 * The profile card — layer 2 of "Wingman knows you", in a usable shape.
 *
 * Wingman collects a lot about a person in separate places: facts learned from
 * chat (user_memory), the Gmail/Calendar onboarding profile, its notes on every
 * connected app (app_knowledge), and observed habits (behaviorPatterns). This
 * service distils them into ONE short, structured card — who they are, their
 * work, the people that matter, active projects, how they like things done,
 * their routine — and that card leads the system prompt of every chat.
 *
 * Rebuilt in the background when the inputs have changed (at most daily per
 * user, a few users per tick). Only states what the inputs support.
 */

const config = require('../config');
const claude = require('../llm/claude');
const usersRepo = require('../db/users');

const MIN_HOURS_BETWEEN = 24;
const PER_TICK = 3;

const SYSTEM = `You write the OPERATING MANUAL an AI chief of staff keeps for the person it works for — the document that lets it run things on their behalf the way THEY would, so they don't need anyone else. You get everything the assistant has seen: what they said, their email, calendar, meetings, tasks, goals, the people they deal with, and how they decided on things the assistant proposed.

Use exactly these headings (leave one out if there is nothing real for it):

WHO: name, where, role — one line.
WORK & BUSINESS: what they do / run, company names, what they sell or deliver, stage.
PRIORITIES RIGHT NOW: ranked, most important first — what actually deserves their time this month (from goals, tasks, meetings, email volume, what they keep coming back to).
KEY PEOPLE: tiered. "VIP" = reply/act fast, never let them wait; "Regular" = normal. For each: name — who they are to the user — how to handle them (e.g. "client, replies within the hour, formal English").
ACTIVE PROJECTS & GOALS: what is in flight and where it stands.
HOW THEY DECIDE: what they approve without changes, what they reject or rewrite, what they always want to see first, money/time thresholds you can see.
WHAT YOU CAN HANDLE FOR THEM: the things the assistant can just take care of (and the ones it already may do without asking), vs. what must come to them.
RHYTHM: working hours, meeting-heavy days, when they read messages, recurring meetings.
WATCH OUT: sensitivities, things they said never to do, open loops, people waiting on them.

Rules: only what the input supports — never guess or pad. Real names and specifics, not generic advice. Bullet points, terse. Max ~2800 characters. Output only the manual.`;

function factsOf(user) {
  try { return require('../db/userMemory').listForUser(user.id, 60); } catch (_) { return []; }
}

function inputsFor(user) {
  const parts = [];
  parts.push(`Name: ${user.name || '(unknown)'} · Timezone: ${user.timezone || '(unknown)'}${user.runs_business ? ' · Runs a business' : ''}`);
  const onboarding = user.preferences && user.preferences.onboarding && user.preferences.onboarding.profile;
  if (onboarding) parts.push(`FROM THEIR EMAIL/CALENDAR/TASKS:\n${String(onboarding).slice(0, 1500)}`);
  const facts = factsOf(user);
  if (facts.length) parts.push(`FACTS LEARNED (explicit = they told us):\n${facts.map((f) => `- [${f.source === 'explicit' ? 'explicit' : 'learned'}/${f.category}] ${f.fact}`).join('\n')}`);
  try {
    const notes = require('../db/appKnowledge').listForUser(user.id).filter((r) => r.note);
    if (notes.length) parts.push(`NOTES ON THEIR CONNECTED APPS:\n${notes.map((r) => `## ${r.app}\n${String(r.note).slice(0, 900)}`).join('\n')}`);
  } catch (_) { /* optional */ }
  try {
    const b = require('./behaviorPatterns').promptBlock(user.id, (user.name || '').split(' ')[0] || 'them');
    if (b) parts.push(`OBSERVED BEHAVIOUR:\n${String(b).slice(0, 1200)}`);
  } catch (_) { /* optional */ }
  try {
    const rules = require('../db/userRules').listForUser(user.id);
    if (rules.length) parts.push(`THEIR STANDING RULES:\n${rules.map((r) => `- ${r.kind}: ${r.text}`).join('\n')}`);
  } catch (_) { /* optional */ }
  for (const fn of [peopleInput, calendarInput, emailInput, workInput, meetingsInput, decisionsInput, styleInput]) {
    try { const s = fn(user); if (s) parts.push(s); } catch (_) { /* each source is optional */ }
  }
  return parts;
}

// ── Raw material from everything Wingman has synced (SQLite only) ────
const { db } = require('../db');
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();
const sqlDaysAgo = (n) => daysAgo(n).replace('T', ' ').slice(0, 19);

function peopleInput(user) {
  const rows = db.prepare(`SELECT name, email, relationship, company, notes, interaction_count, last_contacted_at
    FROM contacts WHERE user_id = ? ORDER BY interaction_count DESC LIMIT 15`).all(user.id);
  if (!rows.length) return '';
  return `PEOPLE THEY DEAL WITH MOST (from email/meetings):\n${rows.map((c) => `- ${c.name || c.email} <${c.email || ''}>${c.company ? `, ${c.company}` : ''}${c.relationship ? `, ${c.relationship}` : ''} · ${c.interaction_count || 0} interactions · last ${String(c.last_contacted_at || '').slice(0, 10)}${c.notes ? ` · ${String(c.notes).slice(0, 120)}` : ''}`).join('\n')}`;
}

function calendarInput(user) {
  const rows = db.prepare('SELECT title, start_time, attendees FROM calendar_events WHERE user_id = ? AND start_time >= ? AND all_day = 0')
    .all(user.id, daysAgo(30).slice(0, 10));
  if (!rows.length) return '';
  const tz = user.timezone || 'Asia/Karachi';
  const titles = {};
  const people = {};
  const hours = {};
  const days = {};
  for (const r of rows) {
    const k = String(r.title || '').trim();
    if (k) titles[k] = (titles[k] || 0) + 1;
    let att = [];
    try { att = JSON.parse(r.attendees || '[]'); } catch (_) { /* none */ }
    for (const a of att) { const e = String((a && a.email) || a || '').toLowerCase(); if (e) people[e] = (people[e] || 0) + 1; }
    const d = new Date(r.start_time);
    if (!Number.isNaN(d.getTime())) {
      const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d);
      const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
      hours[h] = (hours[h] || 0) + 1;
      days[w] = (days[w] || 0) + 1;
    }
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ');
  return `CALENDAR (last 30 days + upcoming, ${rows.length} meetings):\n- Recurring/frequent: ${top(titles, 8)}\n- People they meet most: ${top(people, 8)}\n- Busiest hours: ${top(hours, 4)} · busiest days: ${top(days, 3)}`;
}

function emailInput(user) {
  const rows = db.prepare(`SELECT sender, category, replied FROM email_items WHERE user_id = ? AND COALESCE(received_at, created_at) >= ?`)
    .all(user.id, sqlDaysAgo(30));
  if (!rows.length) return '';
  const important = {};
  const cats = {};
  for (const r of rows) {
    cats[r.category || 'other'] = (cats[r.category || 'other'] || 0) + 1;
    if (r.category === 'urgent' || r.category === 'needs_reply') {
      const s = String(r.sender || '').replace(/\s*<.*>/, '').trim() || r.sender;
      important[s] = (important[s] || 0) + 1;
    }
  }
  const top = Object.entries(important).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} (${v})`).join(', ');
  return `EMAIL (last 30 days, ${rows.length} emails): ${Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(', ')}\n- Who sends them mail that needs them: ${top || '(none)'}`;
}

function workInput(user) {
  const out = [];
  const tasks = db.prepare('SELECT title, priority, due_date FROM tasks WHERE user_id = ? AND completed = 0 ORDER BY priority ASC, COALESCE(due_date, \'9999\') ASC LIMIT 15').all(user.id);
  if (tasks.length) out.push(`OPEN TASKS:\n${tasks.map((t) => `- [P${t.priority}] ${t.title}${t.due_date ? ` (due ${String(t.due_date).slice(0, 10)})` : ''}`).join('\n')}`);
  try {
    const goals = require('../db/goals').listActive(user.id);
    if (goals.length) out.push(`ACTIVE GOALS:\n${goals.map((g) => `- ${g.title}${g.target_date ? ` (by ${String(g.target_date).slice(0, 10)})` : ''}`).join('\n')}`);
  } catch (_) { /* optional */ }
  const fu = db.prepare("SELECT type, description, counterparty FROM followups WHERE user_id = ? AND status = 'open' LIMIT 12").all(user.id);
  if (fu.length) out.push(`OPEN LOOPS:\n${fu.map((f) => `- ${f.type === 'promise_made' ? 'They owe' : 'Owed to them by'} ${f.counterparty || '?'}: ${f.description}`).join('\n')}`);
  return out.join('\n\n');
}

function meetingsInput(user) {
  const rows = db.prepare("SELECT title, meeting_at, summary FROM meetings WHERE user_id = ? AND summary IS NOT NULL AND COALESCE(meeting_at, created_at) >= ? ORDER BY COALESCE(meeting_at, created_at) DESC LIMIT 8")
    .all(user.id, daysAgo(30));
  if (!rows.length) return '';
  return `RECENT MEETINGS:\n${rows.map((m) => {
    let s = {};
    try { s = JSON.parse(m.summary || '{}'); } catch (_) { /* none */ }
    return `- ${m.title || 'Meeting'} (${String(m.meeting_at || '').slice(0, 10)}): ${String(s.overview || '').slice(0, 160)}${(s.decisions || []).length ? ` Decided: ${s.decisions.slice(0, 3).join('; ')}` : ''}`;
  }).join('\n')}`;
}

function decisionsInput(user) {
  return require('./autonomy').decisionSummary(user.id);
}

function styleInput(user) {
  const p = user.preferences && user.preferences.styleProfile;
  if (!p) return '';
  return `HOW THEY COMMUNICATE: ${(p.chat && p.chat.reply_guidance) || ''} ${(p.email && p.email.draft_guidance) ? `Emails: ${p.email.draft_guidance}` : ''}`.trim();
}

/** A cheap fingerprint of the inputs, so we only rebuild when something changed. */
function fingerprint(user) {
  const facts = factsOf(user);
  let notes = '';
  try { notes = require('../db/appKnowledge').listForUser(user.id).map((r) => `${r.app}:${r.studied_at}`).join(','); } catch (_) { /* optional */ }
  const ob = (user.preferences && user.preferences.onboarding && user.preferences.onboarding.profile) || '';
  // Coarse activity counters: the manual is rebuilt when their world moved on.
  let activity = '';
  try {
    const c = (sql) => (db.prepare(sql).get(user.id) || {}).n || 0;
    activity = [
      c('SELECT COUNT(*) n FROM contacts WHERE user_id = ?'),
      Math.floor(c('SELECT COUNT(*) n FROM email_items WHERE user_id = ?') / 20),
      c('SELECT COUNT(*) n FROM meetings WHERE user_id = ? AND summary IS NOT NULL'),
      Math.floor(c('SELECT COUNT(*) n FROM tasks WHERE user_id = ?') / 5),
      c("SELECT COUNT(*) n FROM integration_actions WHERE user_id = ? AND status IN ('done','cancelled')"),
      c('SELECT COUNT(*) n FROM user_rules WHERE user_id = ?'),
    ].join('.');
  } catch (_) { /* optional */ }
  return `${facts.length}|${facts.map((f) => f.updated_at).sort().pop() || ''}|${notes}|${ob.length}|${activity}`;
}

async function refresh(userId, { force = false } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { skipped: 'no_user' };
  const card = (user.preferences && user.preferences.profileCard) || null;
  const fp = fingerprint(user);
  if (!force && card) {
    const ageH = (Date.now() - (Date.parse(card.at) || 0)) / 3600000;
    if (ageH < MIN_HOURS_BETWEEN || card.fp === fp) return { skipped: 'fresh' };
  }
  const inputs = inputsFor(user);
  if (inputs.length < 2) return { skipped: 'not_enough_data' };

  let text;
  try {
    text = await claude.complete(`Everything known about this person:\n\n${inputs.join('\n\n')}\n\nWrite the operating manual now.`, {
      system: SYSTEM, model: config.anthropic.model, maxTokens: 1400,
    });
  } catch (e) {
    console.warn('[profile] build failed:', e.message);
    return { skipped: 'llm_error' };
  }
  text = String(text || '').trim().slice(0, 3200);
  if (text.length < 40) return { skipped: 'empty' };
  usersRepo.updatePreferences(userId, { profileCard: { text, at: new Date().toISOString(), fp } });
  console.log(`[profile] card updated for ${userId}`);
  return { updated: true };
}

/** Scheduler tick: refresh a few users whose inputs changed. */
async function runDue() {
  let users = [];
  try { users = usersRepo.listOnboarded(); } catch (_) { return { updated: 0 }; }
  let updated = 0;
  for (const u of users) {
    if (updated >= PER_TICK) break;
    try {
      const r = await refresh(u.id);
      if (r.updated) updated += 1;
    } catch (e) {
      console.warn(`[profile] ${u.id} failed:`, e.message);
    }
  }
  return { updated };
}

function card(user) {
  return (user && user.preferences && user.preferences.profileCard && user.preferences.profileCard.text) || '';
}

module.exports = { refresh, runDue, card };
