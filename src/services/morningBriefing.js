'use strict';

const usersRepo = require('../db/users');
const calendarEventsRepo = require('../db/calendarEvents');
const emailItemsRepo = require('../db/emailItems');
const tasksRepo = require('../db/tasks');
const billsRepo = require('../db/bills');
const deliveriesRepo = require('../db/deliveries');
const briefingsRepo = require('../db/briefings');
const { db } = require('../db');
const weather = require('./weather');
const t = require('../utils/time');

function wa() { return require('../whatsapp/client'); }

/** Latest health metric for a user, or null. */
function latestHealth(userId) {
  return db.prepare(
    'SELECT * FROM health_data WHERE user_id = ? ORDER BY recorded_at DESC, created_at DESC LIMIT 1'
  ).get(userId);
}

/**
 * Aggregate everything needed for a morning briefing.
 * @returns {Promise<Object>} structured payload
 */
async function aggregate(user, now = new Date()) {
  const tz = user.timezone || 'Asia/Karachi';
  const todayStart = t.startOfDayISO(tz, 0, now);
  const tomorrowStart = t.startOfDayISO(tz, 1, now);
  const in3Days = t.startOfDayISO(tz, 4, now); // through end of +3 days

  const w = await weather.getWeather(user);

  const events = calendarEventsRepo.listStartingBetween(user.id, todayStart, tomorrowStart);

  // Emails in the last 24h — ONLY when a mailbox is actually connected. After a
  // user disconnects their email, its data must stop appearing in updates; with
  // multiple mailboxes connected, the counts naturally cover all of them.
  const emailConnected = require('../auth/googleAuth').isEmailConnected(user);
  const since24 = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const emailCounts = emailConnected
    ? emailItemsRepo.countsSince(user.id, since24)
    : { urgent: 0, needsReply: 0 };

  const tasksDue = tasksRepo.listDueBetween(user.id, todayStart, tomorrowStart);

  const bills = billsRepo.listForUser(user.id, { status: 'pending' })
    .filter((b) => b.due_date && b.due_date >= todayStart.slice(0, 10) && b.due_date <= in3Days.slice(0, 10));

  const deliveries = deliveriesRepo.listForUser(user.id)
    .filter((d) => d.status !== 'delivered');

  const health = latestHealth(user.id);

  // Headlines for the topics the user follows (incl. local news for their city).
  // Best-effort: a slow or failing feed must never hold up the briefing.
  let newsBulletin = null;
  try {
    const news = require('./news');
    newsBulletin = await news.bulletin(user, { perTopic: 2 });
  } catch (err) {
    console.warn('[morningBriefing] news failed:', err.message);
  }

  // NOW HRMS snapshot line (best-effort; a slow HRMS must not hold the briefing).
  let hrmsLine = null;
  try { hrmsLine = await require('./nowHrmsData').briefingLine(user); }
  catch (err) { console.warn('[morningBriefing] hrms failed:', err.message); }

  return {
    tz, weather: w, events, emailConnected, emailCounts, tasksDue, bills, deliveries, health, hrmsLine,
    healthLine: (() => { try { return require('./health').summaryLine(user.id); } catch (_) { return null; } })(),
    news: newsBulletin,
    todayStart, tomorrowStart,
  };
}

/** Format the aggregated payload into the WhatsApp briefing text. */
function format(user, agg) {
  const name = user.name || 'there';
  const tz = agg.tz;
  const lines = [];
  // The briefing can be scheduled at any hour, so greet by the actual clock.
  const hour = t.hourInTz(tz);
  const sunEmoji = hour < 12 ? '\u2600\ufe0f' : (hour < 17 ? '\ud83c\udf24\ufe0f' : '\ud83c\udf06');
  lines.push(`${t.greetingInTz(tz)}, ${name}! ${sunEmoji}`);
  lines.push('');
  lines.push(`\ud83c\udf24 ${agg.weather.city}: ${agg.weather.temp}\u00b0C, ${agg.weather.condition}`);
  lines.push('');

  // Schedule
  lines.push(`\ud83d\udcc5 *Today's Schedule:*`);
  if (agg.events.length) {
    for (const e of agg.events) {
      const time = t.timeLabel(e.start_time, tz);
      const loc = e.location ? ` (${e.location})` : '';
      lines.push(`\u2022 ${time} \u2014 ${e.title || 'Untitled'}${loc}`);
    }
  } else {
    lines.push('\u2022 No meetings \u2014 open runway for deep work. \ud83d\udcaa');
  }
  lines.push('');

  // Email \u2014 only when a mailbox is connected (no email data once disconnected).
  if (agg.emailConnected) {
    lines.push(`\ud83d\udce7 Email: ${agg.emailCounts.urgent} urgent, ${agg.emailCounts.needsReply} need reply`);
    lines.push('');
  }

  // Chief of staff: what Wingman is handling today, and what needs their yes.
  try {
    const plan = require('./chiefOfStaff').morningPlan(user, { eventsToday: agg.events });
    if (plan) { lines.push(plan); lines.push(''); }
  } catch (_) { /* the briefing still goes out */ }

  // Tasks
  lines.push(`\u2705 *Tasks Due Today:*`);
  if (agg.tasksDue.length) {
    for (const task of agg.tasksDue) lines.push(`\u2022 ${task.title}`);
  } else {
    lines.push('\u2022 Nothing due today. \ud83c\udf89');
  }
  lines.push('');

  // NOW HRMS — clock / open tasks / pending leaves, when connected.
  if (agg.hrmsLine) { lines.push(agg.hrmsLine); lines.push(''); }

  // Bills
  if (agg.bills.length) {
    for (const b of agg.bills) {
      const days = t.daysBetween(agg.todayStart, `${b.due_date}T00:00:00${agg.todayStart.slice(-6)}`);
      const when = days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`;
      lines.push(`\ud83d\udcb0 Bills: ${b.name} due ${when} (${b.currency} ${fmtAmount(b.amount)})`);
    }
    lines.push('');
  }

  // Deliveries
  if (agg.deliveries.length) {
    for (const d of agg.deliveries.slice(0, 3)) {
      const eta = d.estimated_delivery ? ` (ETA ${d.estimated_delivery})` : '';
      lines.push(`\ud83d\udce6 Deliveries: ${d.item_name || 'Order'} \u2014 ${prettyStatus(d.status)}${eta}`);
    }
    lines.push('');
  }

  // Health \u2014 the AI analyst's read when we have it (what the numbers mean for
  // them today), falling back to the plain roll-up otherwise.
  if (agg.healthInsight) {
    lines.push(`\u2764\ufe0f ${agg.healthInsight}`);
    lines.push('');
  } else if (agg.healthLine) {
    lines.push(`\u2764\ufe0f Health: ${agg.healthLine}`);
    lines.push('');
  }

  // News bulletin (topics the user picked + their city's local news).
  if (agg.news) {
    try {
      const newsText = require('./news').formatBulletin(agg.news, { perTopic: 2 });
      if (newsText) { lines.push(newsText); lines.push(''); }
    } catch (_) { /* skip */ }
  }

  lines.push(
    hour < 12 ? 'Have a productive day! \ud83d\ude80'
      : hour < 17 ? 'Have a productive afternoon! \ud83d\ude80'
        : 'Have a good evening! \ud83c\udf19'
  );
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Values for the approved WhatsApp template, used when the user is outside the
 * 24h window and only a template will deliver.
 *
 * WhatsApp forbids newlines inside a template parameter, so the layout lives in
 * the template's static text and each parameter carries one section on a single
 * line. Every parameter must be non-empty — Meta rejects blanks — hence the
 * fallbacks. Order must match {{1}}…{{6}} in the approved template.
 */
function templateParams(user, agg) {
  const tz = agg.tz;
  const join = (arr) => arr.filter(Boolean).join('  •  ');

  const greeting = `${t.greetingInTz(tz)}, ${user.name || 'there'}!`;

  const weather = agg.weather
    ? `${agg.weather.city}: ${agg.weather.temp}°C, ${agg.weather.condition}`
    : 'Weather unavailable';

  const schedule = agg.events.length
    ? join(agg.events.map((e) => {
      const loc = e.location ? ` (${e.location})` : '';
      return `${t.timeLabel(e.start_time, tz)} — ${e.title || 'Untitled'}${loc}`;
    }))
    : 'No meetings — open runway for deep work';

  const email = agg.emailConnected
    ? `${agg.emailCounts.urgent} urgent, ${agg.emailCounts.needsReply} need reply`
    : 'No mailbox connected';

  const tasks = agg.tasksDue.length
    ? join(agg.tasksDue.map((x) => x.title))
    : 'Nothing due today';

  // A template cannot skip a section, so anything optional rides along with the
  // closing line rather than needing its own (possibly empty) parameter.
  const extras = [];
  for (const b of agg.bills) extras.push(`💰 ${b.name} due`);
  for (const d of agg.deliveries.slice(0, 2)) extras.push(`📦 ${d.item_name || 'Order'}`);
  // Prefer the AI read; toTemplateParam flattens its lines to fit a template.
  if (agg.healthInsight) extras.push(`❤️ ${agg.healthInsight}`);
  else if (agg.healthLine) extras.push(`❤️ ${agg.healthLine}`);

  const hour = t.hourInTz(tz);
  const closing = hour < 12 ? 'Have a productive day!'
    : hour < 17 ? 'Have a productive afternoon!' : 'Have a good evening!';

  return [
    greeting,
    weather,
    schedule,
    email,
    tasks,
    extras.length ? `${join(extras)}  •  ${closing}` : closing,
  ];
}

/**
 * Variables for the UTILITY "schedule reminder" template:
 *   "Your schedule for {{1}}: {{2}}. Tasks due today: {{3}}. Reply to this
 *    message for your full briefing."
 * One line each, never empty (a template variable can't be blank).
 */
function reminderParams(user, agg, now = new Date()) {
  const tz = agg.tz;
  let dateLabel;
  try {
    dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  } catch (_) {
    dateLabel = 'today';
  }
  const list = (items, max) => {
    const shown = items.slice(0, max).join(', ');
    return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
  };
  const events = agg.events.map((e) => `${t.timeLabel(e.start_time, tz)} ${e.title || 'Untitled'}`.trim());
  const tasks = agg.tasksDue.map((x) => x.title).filter(Boolean);
  return [
    dateLabel,
    events.length ? list(events, 5) : 'no meetings',
    tasks.length ? list(tasks, 5) : 'none',
  ];
}

function fmtAmount(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('en-US');
}

function prettyStatus(s) {
  return (s || 'in_transit').replace(/_/g, ' ');
}

/**
 * Build, store, and (best-effort) send a morning briefing for one user.
 * @returns {Promise<{text:string, sent:boolean}>}
 */
async function sendForUser(userId, { now = new Date(), send = true, full = false } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { text: '', sent: false, skipped: 'no_user' };

  const agg = await aggregate(user, now);

  // The AI health read is computed here (not in aggregate) so only real morning
  // sends pay for the Claude call — the briefing is already deduped to once per
  // local day, which keeps it to one call per user per morning.
  try {
    const insight = require('./healthInsight');
    if (insight.hasEnough(user.id)) {
      agg.healthInsight = await insight.morningCheckin(user.id, { name: user.name });
    }
  } catch (err) {
    console.warn('[morningBriefing] health insight skipped:', err.message);
  }

  const text = format(user, agg);

  let sent = false;
  let sendError = null;
  if (send) {
    try {
      if (wa().ready()) {
        if (full) {
          // On-demand full version (user tapped "View Briefing") — send the rich
          // text directly. Only ever happens when the user just tapped, so the
          // window is open and it isn't proactive spam. skipDedupe so a re-tap is
          // never swallowed by the once-a-day near-duplicate guard.
          await require('../whatsapp/client').sendMessage(user.phone, text, { skipDedupe: true });
          // The same, read aloud — for users who turned on voice briefings.
          try { await require('./briefingCall').sendVoiceNote(user, text); } catch (_) { /* best-effort */ }
        } else {
          // SCHEDULED send: only the concise "tap to view" nudge — never the full
          // free-form wall of text. The tap opens the window and the webhook calls
          // this again with full:true to deliver the rich version.
          const waCfg = require('../config').whatsappCloud;
          const res = await wa().sendProactiveMessage(user, text, {
            now,
            logLabel: 'briefing',
            templateName: waCfg.briefingTemplate,
            templateParams: waCfg.briefingTemplateStyle === 'reminder'
              ? reminderParams(user, agg, now)
              : templateParams(user, agg),
            nudgeOnly: true,
            readyPayload: 'SHOW_BRIEFING',
            readyParams: [user.name || 'there', 'morning briefing'],
          });
          // Went out as a short template (user outside the 24h window): their
          // next message re-opens the window and gets the full briefing.
          if (res && res.viaTemplate) {
            try { require('../db/pendingFullSends').mark(user.id, 'briefing'); } catch (_) { /* best-effort */ }
          }
        }
        sent = true;
      } else console.log('[morningBriefing] (WA not ready) briefing for', user.phone);
    } catch (err) {
      sendError = err.message;
      console.warn('[morningBriefing] send failed:', err.message);
    }
  }

  briefingsRepo.create(userId, {
    type: 'morning',
    content: text,
    sentAt: sent ? now.toISOString() : null,
    payload: {
      events: agg.events.length,
      emailCounts: agg.emailCounts,
      tasksDue: agg.tasksDue.length,
      bills: agg.bills.length,
      deliveries: agg.deliveries.length,
      delivery: { sent, error: sendError },
    },
  });

  return { text, sent, sendError };
}

/**
 * Run for all users whose local time is currently the target hour.
 */
async function runDueUsers({ hour = 7, now = new Date(), windowMin = 15 } = {}) {
  const gate = require('./proactiveGate');
  const users = usersRepo.listOnboarded();
  const results = [];
  for (const u of users) {
    if (!gate.allows(u, 'morning')) continue;
    const tz = u.timezone || 'Asia/Karachi';
    // Honour each user's own briefing_time (HH:MM); fall back to the legacy hour.
    const target = u.briefing_time || `${String(hour).padStart(2, '0')}:00`;
    if (!t.isDueAt(tz, target, now, windowMin)) continue;

    // Send at most once per local day.
    const dayKey = t.dateKeyInTz(tz, now);
    if ((u.preferences || {}).lastBriefingDate === dayKey) continue;

    let result;
    try {
      // Users who turned on briefing calls get a WhatsApp call instead; if the
      // call can't be placed, the text goes out as usual (and a missed call
      // falls back to text + voice note later — see briefingCall.runPoll).
      const call = require('./briefingCall');
      if (call.shouldCall(u)) {
        const c = await call.start(u, 'briefing', { now });
        if (c.started) result = { sent: true, viaCall: true };
      }
      if (!result) result = await sendForUser(u.id, { now });
    } catch (e) { console.warn('[morningBriefing] failed for', u.id, e.message); continue; }  // one user's failure never stops the rest
    results.push({ phone: u.phone, at: target, ...result });

    if (result.sent) {
      // Re-read so we don't clobber preference changes made while sending.
      const fresh = usersRepo.getById(u.id) || u;
      const prefs = fresh.preferences || {};
      prefs.lastBriefingDate = dayKey;
      usersRepo.update(u.id, { preferences: prefs });
    }
  }
  if (results.length) console.log('[morningBriefing] sent to', results.length, 'user(s)');
  return results;
}

module.exports = { aggregate, format, templateParams, reminderParams, sendForUser, runDueUsers };
