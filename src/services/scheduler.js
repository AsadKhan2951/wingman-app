'use strict';

const cron = require('node-cron');

const morningBriefing = require('./morningBriefing');
const endOfDayWrap = require('./endOfDayWrap');
const taskIntents = require('../engine/taskIntents');
const billAlerts = require('./billAlerts');
const deliveryAlerts = require('./deliveryAlerts');
const followupTracker = require('./followupTracker');
const travelAssistant = require('./travelAssistant');
const meetingPrep = require('./meetingPrep');
const meetingComplete = require('./meetingComplete');
const calendarSync = require('./calendarSync');
const leaveByAlerts = require('./leaveByAlerts');
const healthAlerts = require('./healthAlerts');
const workAlerts = require('./workAlerts');
const taskDueAlerts = require('./taskDueAlerts');

const jobs = [];

// A tick that is still running when the next one fires is skipped, not run in
// parallel — two overlapping briefing ticks are how users get things twice.
const running = new Set();
async function exclusive(name, fn) {
  if (running.has(name)) {
    console.warn(`[scheduler] ${name} tick still running — skipping this one`);
    return;
  }
  running.add(name);
  try { await fn(); } finally { running.delete(name); }
}

/** Run one job; its failure is logged and never stops the jobs after it. */
async function step(name, fn) {
  try { await fn(); }
  catch (e) { console.warn(`[scheduler] ${name} failed:`, e && e.message ? e.message : e); }
}

/**
 * Because users can be in different timezones, we run a single cron job at the
 * top of every hour and each service decides which users' local time matches
 * its target hour. This keeps scheduling correct across timezones without
 * spinning up per-user crons.
 *
 * Target local hours:
 *   07:00 → morning briefing
 *   09:00 → daily task reminder, bill alerts, delivery return-window check, follow-up overdue check
 *   20:00 → end-of-day wrap
 * Every hour (time-based, not local-hour-gated):
 *   → travel alerts (24h / 3h before flights, arrival-day briefing)
 */
async function runHourlyTick(now = new Date()) {
  // Collapse any duplicate/junk accounts created since boot, so proactive jobs
  // never send twice to the same person (was boot-only before).
  await step('merge duplicates', () => require('../db/users').mergeDuplicatePhones());
  // Trim the WhatsApp send-dedup guard (rows only matter for ~2 min).
  await step('dedup trim', () => require('../db').db.prepare("DELETE FROM wa_send_dedup WHERE created_at < datetime('now','-1 hour')").run());
  await step('google tasks sync', () => require('./googleTasks').syncAllUsers({ now }));
  await step('task reminders', () => taskIntents.runDailyReminders({ hour: 9, now }));
  await step('bill alerts', () => billAlerts.runDueUsers({ hour: 9, now }));
  await step('delivery alerts', () => deliveryAlerts.runDueUsers({ hour: 9, now }));
  await step('follow-ups', () => followupTracker.runDueUsers({ hour: 9, now }));
  await step('travel', () => travelAssistant.runDueUsers({ now }));
  // "Always working on your goals" — surface each active goal's next step once
  // a day (goalCoach gates itself to daytime + once/goal/day).
  await step('goal coach', () => require('./goalCoach').runAllUsers({ now }));
  // Deepen / refresh Wingman's understanding of each user's connected apps
  // (day 1, 3, 7 after connecting, then weekly). A few per tick, one at a time.
  await step('app study', () => require('./appStudy').runDue({ now }));
  // Re-distil each user's profile card when what we know about them changed.
  await step('profile cards', () => require('./userProfile').runDue());
  // Keep learning every user, not only the ones chatting right now: facts and
  // their corrections (rules) from recent chat, and how they write.
  await step('behaviour learner', () => require('./behaviorLearner').runAllUsers());
  await step('style profiles', () => require('./styleProfile').runDue({ now }));
  // Chief-of-staff inbox: replies drafted in their voice before they ask.
  await step('reply drafts', () => require('./replyDrafter').runDue());
}

/**
 * Briefing tick — every 15 minutes. The morning briefing and end-of-day wrap
 * fire at each user's OWN configured briefing_time / debrief_time (in their
 * timezone), so a 15-minute cadence is needed to honour half-hour settings like
 * "07:30". Each service de-dupes to once per local day.
 */
async function runBriefingTick(now = new Date()) {
  // Collapse any duplicate account rows for the same phone BEFORE we send, so a
  // person who somehow ends up with two rows can never receive two briefings or
  // two wraps.
  await step('merge duplicates', () => require('../db/users').mergeDuplicatePhones());
  // ~30 min before each user's briefing/wrap: pull everything fresh (and
  // pre-build the briefing for users who get a call).
  await step('pre-briefing refresh', () => require('./preBriefing').runDue({ now, windowMin: 15 }));
  await step('morning briefing', () => morningBriefing.runDueUsers({ now, windowMin: 15 }));
  await step('end-of-day wrap', () => endOfDayWrap.runDueUsers({ now, windowMin: 15 }));
  // The cross-domain proactive nudge — gated to a couple of local hours and
  // to days that actually have something time-sensitive.
  await step('proactive brain', () => require('./proactiveBrain').runDueUsers({ now }));
  // Standing instructions the user set up ("every morning send me traffic").
  // Retune behaviour-anchored ones (e.g. "before I usually leave") FIRST so
  // today's fire uses the freshly-learned time, then sweep and fire.
  await step('automations retune', () => require('./automations').retuneAnchored({ now }));
  await step('automations', () => require('./automations').runDueUsers({ now, windowMin: 15 }));
  // "Getting to know you" — drive the 7-day onboarding calibration window.
  await step('onboarding analyzer', () => require('./onboardingAnalyzer').runDueUsers({ now }));
}

/**
 * Meeting tick — runs every 15 minutes. First syncs each connected user's
 * Google Calendar (so the cache is fresh), then sends prep reminders for events
 * about to start and "just wrapped up" notes for events that recently ended.
 */
async function runMeetingPrepTick(now = new Date()) {
  await step('calendar sync', () => calendarSync.syncAllUsers({ now }));   // refresh cache from Google first
  await step('meeting prep', () => meetingPrep.runAllUsers({ now }));      // reminders before meetings
  await step('meeting complete', () => meetingComplete.runAllUsers({ now }));  // "that wrapped up" after meetings
  await step('leave-by', () => leaveByAlerts.runAllUsers({ now }));        // "leave by X" for events with a location
  // Pull fresh readings BEFORE the health alerts run, so an alert reacts to
  // what synced this tick rather than to yesterday's picture.
  await step('google health sync', () => require('./googleHealth').syncAllUsers({ days: 2 }));
  await step('wearables sync', () => require('./wearables').syncAllUsers({ days: 2 }));
  await step('webmail alerts', () => require('./webmailAlerts').runAllUsers({}));  // new customer mail
  await step('webmail inbox', () => require('./webmailInbox').syncAllUsers());     // business mail → app
  await step('health alerts', () => healthAlerts.runAllUsers({ now }));
  await step('work alerts', () => workAlerts.runAllUsers({ now }));
  await step('clock-in reminders', () => workAlerts.runClockInReminders({ now }));
  await step('task due alerts', () => taskDueAlerts.runAllUsers({ now }));   // tasks due in ~15 minutes
  // Keep the search index (search_user_data) in step with everything synced above.
  await step('search index', () => require('./userIndex').syncAll());
}

/**
 * Initialize all cron jobs. Called once on server start.
 */
function init() {
  const hourly = cron.schedule('0 * * * *', () => exclusive('hourly', () => runHourlyTick(new Date())));
  jobs.push(hourly);

  const prep = cron.schedule('*/15 * * * *', () => exclusive('meeting', () => runMeetingPrepTick(new Date())));
  jobs.push(prep);

  const brief = cron.schedule('*/15 * * * *', () => exclusive('briefing', () => runBriefingTick(new Date())));
  jobs.push(brief);

  // Notetaker bot — every MINUTE so auto-join feels near-instant: (1) AUTO-JOIN —
  // for opted-in users, refresh their calendar and send the bot to any meeting
  // that's ongoing or about to start (so it joins on its own, no manual command,
  // within ~a minute of the user joining); (2) poll Recall so notes land soon
  // after the call ends. No-op unless a bot engine (RECALL_API_KEY) is configured.
  const botTick = cron.schedule('* * * * *', () => exclusive('notetaker', async () => {
    await step('auto-join', () => require('./meetingBotDispatch').runAutoJoinTick({ now: new Date() }));
    // Processing a finished meeting can take minutes; exclusive() keeps the
    // next minute's poll from picking up the same meeting in parallel.
    await step('recall poll', () => require('./recallPoll').runOnce());
    // Briefing calls: answered → note in history; missed → text + voice note.
    await step('briefing calls', () => require('./briefingCall').runPoll());
  }));
  jobs.push(botTick);

  console.log('[scheduler] registered hourly tick (alerts 09:00, travel) + every 15 min: calendar-sync/meeting-prep/meeting-complete/task-due and briefing/debrief at each user\'s own set time, per-user TZ');
  return jobs;
}

function stopAll() {
  for (const j of jobs) { try { j.stop(); } catch (_) {} }
  jobs.length = 0;
}

module.exports = { init, runHourlyTick, runMeetingPrepTick, runBriefingTick, stopAll };
