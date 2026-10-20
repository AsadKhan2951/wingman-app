'use strict';
/**
 * Offline checks for the meeting follow-up agent: agenda from the invite →
 * what's still open → who → a free slot → proposal with the notes → booking on
 * "yes". LLM and Google Calendar are stubbed; nothing is sent.
 *   node scripts/test-meeting-followup.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fu-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';

const dbm = require('../src/db');
dbm.initSchema();
const { db } = dbm;
const users = require('../src/db/users');
const meetings = require('../src/db/meetings');
const calEvents = require('../src/db/calendarEvents');
const claude = require('../src/llm/claude');
const calendar = require('../src/services/calendar');
const fu = require('../src/services/meetingFollowup');
const ingest = require('../src/services/meetingIngest');
const { executeFollowupTool } = require('../src/engine/followupTools');
const t = require('../src/utils/time');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  let u = users.create({ phone: '923001236666' });
  users.update(u.id, { name: 'Aamir Younus', onboarding_complete: 1, timezone: 'Asia/Karachi', work_hours_start: '10:00', work_hours_end: '18:00' });
  u = users.getById(u.id);
  db.prepare("INSERT INTO google_accounts (id, user_id, email, token) VALUES ('ga1', ?, 'aamir@heard.pk', '{}')").run(u.id);
  db.prepare("INSERT INTO contacts (id, user_id, name, phone, email) VALUES ('c1', ?, 'Ali Raza', '923331112222', 'ali@client.com')").run(u.id);

  const now = new Date();
  const startIso = new Date(now.getTime() - 60 * 60e3).toISOString();
  calEvents.upsert(u.id, {
    gcalEventId: 'gev1', title: 'Q4 pricing review', startTime: startIso, endTime: new Date(now.getTime() - 5 * 60e3).toISOString(),
    description: 'Agenda:<br>1. Final pricing for Q4<br>2. Launch date<br>3. Hiring plan<br><br>Join with Google Meet: https://meet.google.com/abc-defg-hij<br>Learn more about Meet at: https://support.google.com',
    attendees: ['aamir@heard.pk', 'ali@client.com', 'sara@client.com', 'notetaker@imyourwingman.ai'],
  });
  const m = meetings.create(u.id, {
    title: 'Q4 pricing review', meetingAt: startIso,
    attendees: [{ name: 'Aamir', email: 'aamir@heard.pk' }, { name: 'Ali Raza', email: 'ali@client.com' }, { name: 'Sara Khan', email: 'sara@client.com' }, { name: 'Wingman Notetaker', email: 'notetaker@imyourwingman.ai' }],
  });
  db.prepare("INSERT INTO meeting_bots (id, user_id, meeting_id, gcal_event_id, meeting_url) VALUES ('b1', ?, ?, 'gev1', 'https://meet.google.com/abc')").run(u.id, m.id);

  // ── Agenda comes from the invite, without the Meet boilerplate ───────
  const agenda = fu.findAgenda(u.id, m);
  check('agenda read from the calendar invite', /Final pricing for Q4/.test(agenda) && /Hiring plan/.test(agenda), agenda);
  check('…video-call boilerplate stripped', !/meet\.google\.com|Learn more about Meet/.test(agenda));

  // ── Summary marks each agenda point; open ones → follow-up plan ──────
  let sentPrompt = '';
  claude.complete = async (prompt) => {
    sentPrompt = prompt;
    return JSON.stringify({
      noContent: false, overview: 'Reviewed Q4 pricing; launch date agreed.',
      discussion: ['Pricing tiers'], decisions: ['Launch on 3 Nov'],
      actions: [{ task: 'Send revised price sheet', owner: 'Ali Raza', due: 'Friday', priority: 'High' }, { task: 'Share hiring budget', owner: 'Aamir', due: '', priority: 'Medium' }],
      openQuestions: [], followUps: [],
      agenda: [
        { item: 'Final pricing for Q4', status: 'partial', note: 'enterprise tier not agreed' },
        { item: 'Launch date', status: 'done', note: '3 Nov' },
        { item: 'Hiring plan', status: 'not_discussed', note: '' },
      ],
      unresolved: ['Enterprise tier pricing'],
    });
  };
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const out = await ingest.processTranscript(u, meetings.getForUser(u.id, m.id), `We discussed pricing and the launch. ${words}`);
  check('summarizer was given the agenda', /AGENDA \(from the calendar invite\)/.test(sentPrompt) && /Hiring plan/.test(sentPrompt));
  check('summary keeps agenda statuses', out.summary.agenda.length === 3 && out.summary.agenda[1].status === 'done' && out.summary.unresolved.length === 1);

  const plan = fu.forMeeting(u.id, m.id);
  check('follow-up planned for the open points only', plan && plan.items.length === 2 && plan.items.some((i) => /Final pricing/.test(i)) && plan.items.some((i) => /Hiring plan/.test(i)) && !plan.items.some((i) => /Launch date/.test(i)), JSON.stringify(plan && plan.items));
  check('"unresolved" duplicate of an agenda point not repeated', !plan.items.some((i) => /^Enterprise tier pricing$/.test(i)) || plan.items.length <= 3);
  check('invitees = the other people (not the user, not the bot)', plan.attendees.map((a) => a.email).join(',') === 'ali@client.com,sara@client.com', JSON.stringify(plan.attendees));
  check('…matched to contacts (name + WhatsApp number)', plan.attendees[0].phone === '923331112222' && plan.attendees[0].name === 'Ali Raza');

  const slot = plan.proposed_start;
  const tz = u.timezone;
  const local = slot && t.partsInTz(new Date(slot), tz);
  const mins = local ? Number(local.hour) * 60 + Number(local.minute) : -1;
  const wd = slot && new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(slot));
  check('proposed slot: future weekday inside work hours', slot && Date.parse(slot) > now.getTime() && mins >= 600 && mins + 30 <= 1080 && wd !== 'Sat' && wd !== 'Sun', `${slot} ${wd} ${mins}`);

  // Busy slot is skipped.
  db.prepare("INSERT INTO calendar_events (id, user_id, gcal_event_id, title, start_time, end_time) VALUES ('busy1', ?, 'busy', 'Busy', ?, ?)")
    .run(u.id, slot, new Date(Date.parse(slot) + 60 * 60e3).toISOString());
  const slot2 = fu.suggestSlot(u, { now });
  check('a busy time is never proposed', slot2 && (Date.parse(slot2) >= Date.parse(slot) + 60 * 60e3 || Date.parse(slot2) + 30 * 60e3 <= Date.parse(slot)), `${slot} → ${slot2}`);

  const others = require('../src/db/followups').listOpen(u.id);
  check("someone else's action item → a follow-up to chase, not the user's own", others.length === 1 && others[0].counterparty === 'Ali Raza' && /price sheet/.test(others[0].description));

  // ── WhatsApp notes carry the proposal ───────────────────────────────
  const msg = ingest.formatNotesMessage(meetings.getForUser(u.id, m.id), out.summary);
  check('notes message lists what is still open + asks to book', /Still open after this meeting/.test(msg) && /Hiring plan/.test(msg) && /with Ali & Sara/.test(msg) && /send the invites/.test(msg), msg.split('\n').slice(-6).join(' / '));
  users.updatePreferences(u.id, { styleProfile: { chat: { language: 'Roman Urdu mixed with English' } } });
  const msgUr = ingest.formatNotesMessage(meetings.getForUser(u.id, m.id), out.summary);
  check('…in Roman Urdu for a user who talks that way', /hal nahi huin/.test(msgUr) && /Haan/.test(msgUr));

  const block = fu.promptBlock(users.getById(u.id));
  check('chat prompt knows the pending follow-up (so "haan" works)', block.includes(plan.id) && /schedule_meeting_followup/.test(block));

  // ── "Yes" → booked with everyone invited ────────────────────────────
  const auto = await executeFollowupTool(u, { name: 'schedule_meeting_followup', input: { followup_id: plan.id } }, { automated: true });
  check('automated runs can never send invites', auto.error === 'NEEDS_USER_CONFIRMATION');
  let created = null;
  calendar.createEvent = async (userId, ev) => { created = ev; return { gcalEventId: 'new-ev', ...ev }; };
  const booked = await executeFollowupTool(u, { name: 'schedule_meeting_followup', input: { followup_id: plan.id } }, {});
  check('booked on Google Calendar', booked.scheduled === true && created && created.title === 'Follow-up: Q4 pricing review', JSON.stringify(booked));
  check('…all attendees invited', created.attendees.join(',') === 'ali@client.com,sara@client.com');
  check('…open points are the invite agenda', /Final pricing for Q4/.test(created.description) && /Hiring plan/.test(created.description));
  check('…30 minutes at the proposed time', Date.parse(created.endTime) - Date.parse(created.startTime) === 30 * 60e3 && created.startTime === plan.proposed_start);
  const twice = await executeFollowupTool(u, { name: 'schedule_meeting_followup', input: { followup_id: plan.id } }, {});
  check('never booked twice', twice.error === 'ALREADY_SCHEDULED');
  check('no longer pending', fu.listPending(u.id).length === 0 && fu.promptBlock(users.getById(u.id)) === '');

  // ── A meeting where everything landed → no follow-up ────────────────
  const m2 = meetings.create(u.id, { title: 'Standup', meetingAt: startIso, attendees: [{ name: 'Ali', email: 'ali@client.com' }] });
  claude.complete = async () => JSON.stringify({ overview: 'All good.', discussion: ['x'], decisions: ['y'], actions: [], openQuestions: [], followUps: [], agenda: [], unresolved: [] });
  await ingest.processTranscript(u, m2, `Quick sync. ${words}`);
  check('nothing open → no proposal, no noise', !fu.forMeeting(u.id, m2.id) && !/Still open/.test(ingest.formatNotesMessage(meetings.getForUser(u.id, m2.id), {})));

  // Different time + dismiss.
  const m3 = meetings.create(u.id, { title: 'Vendor call', meetingAt: startIso, attendees: [{ name: 'Bilal', email: 'bilal@v.com' }] });
  const p3 = fu.prepare(u, m3, { agenda: [], unresolved: ['Contract terms'] });
  const custom = '2030-01-08T16:00:00+05:00';
  calendar.createEvent = async (userId, ev) => { created = ev; return { gcalEventId: 'e3' }; };
  await executeFollowupTool(u, { name: 'schedule_meeting_followup', input: { followup_id: p3.id, start_time: custom, duration_minutes: 45 } }, {});
  check('user-picked time + length respected', created.startTime === custom && Date.parse(created.endTime) - Date.parse(custom) === 45 * 60e3);
  const m4 = meetings.create(u.id, { title: 'Intro', meetingAt: startIso, attendees: [] });
  const p4 = fu.prepare(u, m4, { unresolved: ['Next steps'] });
  const d = await executeFollowupTool(u, { name: 'dismiss_meeting_followup', input: { followup_id: p4.id } }, {});
  check('dismiss works', d.dismissed && fu.getForUser(u.id, p4.id).status === 'dismissed');

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
