'use strict';

const usersRepo = require('../db/users');
const calendarEventsRepo = require('../db/calendarEvents');
const emailItemsRepo = require('../db/emailItems');
const tasksRepo = require('../db/tasks');
const billsRepo = require('../db/bills');
const followupsRepo = require('../db/followups');
const briefingsRepo = require('../db/briefings');
const t = require('../utils/time');

function wa() { return require('../whatsapp/client'); }

/**
 * Aggregate the end-of-day picture.
 */
function aggregate(user, now = new Date()) {
  const tz = user.timezone || 'Asia/Karachi';
  const todayStart = t.startOfDayISO(tz, 0, now);
  const tomorrowStart = t.startOfDayISO(tz, 1, now);
  const dayAfter = t.startOfDayISO(tz, 2, now);

  const totalTasks = tasksRepo.countAll(user.id);
  const completedToday = tasksRepo.countCompleted(user.id, todayStart);
  const completedTasks = completedToday; // "completed today" per spec
  const incomplete = tasksRepo.listForUser(user.id, { includeCompleted: false });

  // Email figures only when a mailbox is connected — once the user disconnects
  // their email, its data must not surface in the wrap either.
  const emailConnected = require('../auth/googleAuth').isEmailConnected(user);
  const repliedEmails = emailConnected ? emailItemsRepo.countReplied(user.id) : 0;
  const pendingEmails = emailConnected ? emailItemsRepo.countPending(user.id) : 0;

  // Meetings today (attended = happened before now today)
  const todaysEvents = calendarEventsRepo.listStartingBetween(user.id, todayStart, tomorrowStart);

  // Tomorrow
  const tomorrowEvents = calendarEventsRepo.listStartingBetween(user.id, tomorrowStart, dayAfter);

  // Bills due tomorrow
  const tomorrowDate = tomorrowStart.slice(0, 10);
  const billsTomorrow = billsRepo.listForUser(user.id, { status: 'pending' })
    .filter((b) => b.due_date === tomorrowDate);

  // Open follow-ups (still pending)
  const openFollowups = followupsRepo.listOpen(user.id);

  return {
    tz, totalTasks, completedTasks, incomplete,
    emailConnected, repliedEmails, pendingEmails,
    meetingsAttended: todaysEvents.length,
    tomorrowEvents, billsTomorrow, openFollowups, tomorrowDate,
  };
}

function format(user, agg) {
  const name = user.name || 'there';
  const tz = agg.tz;
  const lines = [];
  lines.push(`That's a wrap, ${name}! \ud83c\udf19`);
  lines.push('');
  lines.push(`\u2705 Completed: ${agg.completedTasks}/${agg.totalTasks} tasks`);
  if (agg.emailConnected) {
    lines.push(`\ud83d\udce7 Emails handled: replied to ${agg.repliedEmails}, ${agg.pendingEmails} still pending`);
  }
  lines.push(`\ud83d\udcc5 Meetings attended: ${agg.meetingsAttended}`);
  lines.push('');

  // Chief of staff: what Wingman did today, what's waiting on them, who owes them.
  try {
    const report = require('./chiefOfStaff').eveningReport(user);
    if (report) { lines.push(report); lines.push(''); }
  } catch (_) { /* the wrap still goes out */ }

  // Still pending
  const pending = [];
  for (const task of agg.incomplete.slice(0, 5)) pending.push(task.title);
  for (const f of agg.openFollowups.slice(0, 3)) {
    if (f.type === 'promise_made') pending.push(`You said you'd ${f.description}`);
  }
  if (pending.length) {
    lines.push('Still pending:');
    for (const p of pending) lines.push(`\u2022 ${p}`);
    lines.push('');
  }

  // Tomorrow
  lines.push('Tomorrow:');
  lines.push(`\u2022 ${agg.tomorrowEvents.length} meeting${agg.tomorrowEvents.length === 1 ? '' : 's'}`);
  if (agg.tomorrowEvents[0]) {
    lines.push(`\u2022 ${t.timeLabel(agg.tomorrowEvents[0].start_time, tz)} \u2014 ${agg.tomorrowEvents[0].title}`);
  }
  for (const b of agg.billsTomorrow) {
    lines.push(`\u2022 \ud83d\udcb0 ${b.name} due tomorrow (${b.currency} ${Number(b.amount || 0).toLocaleString('en-US')})`);
  }
  lines.push('');
  // The wrap can be scheduled at any hour \u2014 only say "good night" if it is one.
  const wrapHour = t.hourInTz(tz);
  lines.push(wrapHour >= 20 || wrapHour < 5 ? 'Good night! \ud83d\udca4' : 'Enjoy the rest of your day! \ud83d\udc4b');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Values for the approved wrap template, used outside the 24h window. Same rule
 * as the briefing: no newlines inside a parameter, none may be empty, and the
 * order must match {{1}}…{{7}} in the approved template.
 */
function templateParams(user, agg) {
  const tz = agg.tz;
  const join = (arr) => arr.filter(Boolean).join('  •  ');

  const pending = [];
  for (const task of agg.incomplete.slice(0, 5)) pending.push(task.title);
  for (const f of agg.openFollowups.slice(0, 3)) {
    if (f.type === 'promise_made') pending.push(`You said you'd ${f.description}`);
  }

  const tomorrow = [`${agg.tomorrowEvents.length} meeting${agg.tomorrowEvents.length === 1 ? '' : 's'}`];
  if (agg.tomorrowEvents[0]) {
    tomorrow.push(`${t.timeLabel(agg.tomorrowEvents[0].start_time, tz)} — ${agg.tomorrowEvents[0].title}`);
  }
  for (const b of agg.billsTomorrow) {
    tomorrow.push(`💰 ${b.name} due (${b.currency} ${Number(b.amount || 0).toLocaleString('en-US')})`);
  }

  const wrapHour = t.hourInTz(tz);

  return [
    `That's a wrap, ${user.name || 'there'}!`,
    `${agg.completedTasks}/${agg.totalTasks} tasks`,
    agg.emailConnected ? `replied to ${agg.repliedEmails}, ${agg.pendingEmails} still pending` : 'No mailbox connected',
    String(agg.meetingsAttended),
    pending.length ? join(pending) : 'Nothing left over',
    join(tomorrow),
    wrapHour >= 20 || wrapHour < 5 ? 'Good night! 💤' : 'Enjoy the rest of your day! 👋',
  ];
}

async function sendForUser(userId, { now = new Date(), send = true, full = false } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { text: '', sent: false, skipped: 'no_user' };

  const agg = aggregate(user, now);
  const text = format(user, agg);

  let sent = false;
  let sendError = null;
  if (send) {
    try {
      if (wa().ready()) {
        if (full) {
          // On-demand full version (user tapped "View") — direct rich text.
          // skipDedupe so a re-tap is never swallowed by the once-a-day guard.
          await require('../whatsapp/client').sendMessage(user.phone, text, { skipDedupe: true });
          // The same, read aloud — for users who turned on voice briefings.
          try { await require('./briefingCall').sendVoiceNote(user, text); } catch (_) { /* best-effort */ }
        } else {
          // SCHEDULED send: concise "tap to view" nudge only, not the full wrap.
          const res = await wa().sendProactiveMessage(user, text, {
            now,
            logLabel: 'wrap',
            templateName: require('../config').whatsappCloud.wrapTemplate,
            templateParams: templateParams(user, agg),
            nudgeOnly: true,
            readyTemplate: require('../config').whatsappCloud.wrapReadyTemplate,
            readyPayload: 'SHOW_WRAP',
            readyParams: [user.name || 'there', "day's wrap"],
          });
          if (res && res.viaTemplate) {
            try { require('../db/pendingFullSends').mark(user.id, 'wrap'); } catch (_) { /* best-effort */ }
          }
        }
        sent = true;
      }
      else console.log('[endOfDayWrap] (WA not ready) wrap for', user.phone);
    } catch (err) {
      sendError = err.message;
      console.warn('[endOfDayWrap] send failed:', err.message);
    }
  }

  briefingsRepo.create(userId, {
    type: 'evening',
    content: text,
    sentAt: sent ? now.toISOString() : null,
    payload: {
      completed: agg.completedTasks, total: agg.totalTasks,
      replied: agg.repliedEmails, pending: agg.pendingEmails,
      meetings: agg.meetingsAttended, tomorrow: agg.tomorrowEvents.length,
      delivery: { sent, error: sendError },
    },
  });

  return { text, sent, sendError };
}

async function runDueUsers({ hour = 20, now = new Date(), windowMin = 15 } = {}) {
  const gate = require('./proactiveGate');
  const users = usersRepo.listOnboarded();
  const results = [];
  for (const u of users) {
    if (!gate.allows(u, 'wrap')) continue;
    const tz = u.timezone || 'Asia/Karachi';
    // Honour each user's own debrief_time (HH:MM); fall back to the legacy hour.
    const target = u.debrief_time || `${String(hour).padStart(2, '0')}:00`;
    if (!t.isDueAt(tz, target, now, windowMin)) continue;

    // Send at most once per local day.
    const dayKey = t.dateKeyInTz(tz, now);
    if ((u.preferences || {}).lastDebriefDate === dayKey) continue;

    let result;
    try {
      // Users who turned on briefing calls get a WhatsApp call instead; if the
      // call can't be placed, the text goes out as usual (and a missed call
      // falls back to text + voice note later — see briefingCall.runPoll).
      const call = require('./briefingCall');
      if (call.shouldCall(u)) {
        const c = await call.start(u, 'wrap', { now });
        if (c.started) result = { sent: true, viaCall: true };
      }
      if (!result) result = await sendForUser(u.id, { now });
    } catch (e) { console.warn('[endOfDayWrap] failed for', u.id, e.message); continue; }  // one user's failure never stops the rest
    results.push({ phone: u.phone, at: target, ...result });

    if (result.sent) {
      const fresh = usersRepo.getById(u.id) || u;
      const prefs = fresh.preferences || {};
      prefs.lastDebriefDate = dayKey;
      usersRepo.update(u.id, { preferences: prefs });
    }
  }
  if (results.length) console.log('[endOfDayWrap] sent to', results.length, 'user(s)');
  return results;
}

module.exports = { aggregate, format, templateParams, sendForUser, runDueUsers };
