'use strict';

const tasksRepo = require('../db/tasks');
const usersRepo = require('../db/users');
const t = require('../utils/time');

function wa() { return require('../whatsapp/client'); }

/**
 * Classify a task-management intent from free text.
 * Returns { type, phrase } or null.
 *   type: 'list' | 'overdue' | 'complete' | 'move'
 */
function detect(text) {
  const s = (text || '').toLowerCase().trim();

  if (/\b(what('| i)?s?\s+overdue|overdue tasks?|anything overdue)\b/.test(s)) {
    return { type: 'overdue' };
  }
  if (/\b(what are my tasks|my tasks|list tasks|show( me)? (my )?tasks|to-?do list|todos?|google tasks?|task app)\b/.test(s)) {
    return { type: 'list' };
  }

  let m = s.match(/^(?:done with|completed|finished|mark done|i (?:did|completed|finished))\s+(.+)$/);
  if (!m) m = s.match(/^(.+?)\s+(?:is )?(?:done|completed|finished)$/);
  if (m) return { type: 'complete', phrase: cleanPhrase(m[1]) };

  m = s.match(/^move\s+(.+?)\s+to\s+(tomorrow|today|next week)\b/);
  if (m) return { type: 'move', phrase: cleanPhrase(m[1]), when: m[2] };

  return null;
}

function cleanPhrase(p) {
  return (p || '').replace(/^(the|my|task)\s+/i, '').replace(/["'.]/g, '').trim();
}

/**
 * Handle a detected task intent. Returns a WhatsApp reply string.
 */
async function handle(user, intent, now = new Date()) {
  const tz = user.timezone || 'Asia/Karachi';
  try {
    const googleTasks = require('../services/googleTasks');
    if (googleTasks.isConnected(user)) await googleTasks.syncUser(user.id);
  } catch (_) { /* best-effort */ }

  if (intent.type === 'list') {
    const tasks = tasksRepo.listForUser(user.id, { includeCompleted: false });
    if (!tasks.length) return "You're all clear \u2014 no pending tasks. \ud83c\udf89";
    const lines = ['\u2705 *Your Tasks:*'];
    for (const task of tasks) lines.push(`\u2022 ${task.title}${dueSuffix(task, tz)}`);
    return lines.join('\n');
  }

  if (intent.type === 'overdue') {
    const nowISO = now.toISOString();
    const overdue = tasksRepo.listOverdue(user.id, nowISO);
    if (!overdue.length) return 'Nothing overdue \u2014 you\u2019re on top of it. \ud83d\udcaa';
    const lines = ['\u23f0 *Overdue:*'];
    for (const task of overdue) lines.push(`\u2022 ${task.title}${dueSuffix(task, tz)}`);
    return lines.join('\n');
  }

  if (intent.type === 'complete') {
    const r = await require('../services/taskDone').complete(user, { query: intent.phrase });
    // Not sure which one → let the full assistant ask (returning null hands it over).
    if (!r.completed) return null;
    if (r.tasks.length) return `Marked *${r.tasks[0].title}* as done. \u2705${r.stopped_reminders.length ? ' No more reminders for it.' : ''}`;
    return `Marked *${r.goal_steps_done[0]}* as done on your goal *${r.goal}*. \u2705`;
  }

  if (intent.type === 'move') {
    const task = tasksRepo.findByTitle(user.id, intent.phrase);
    if (!task) return `I couldn't find a task matching "${intent.phrase}".`;
    const dayOffset = intent.when === 'today' ? 0 : intent.when === 'next week' ? 7 : 1;
    // Move to 9am local of the target day
    const start = t.startOfDayISO(tz, dayOffset, now); // midnight local
    const due = start.replace('T00:00:00', 'T09:00:00');
    tasksRepo.updateDueDate(task.id, due);
    try { await require('../services/googleTasks').mirrorTaskUpdate(task.id); } catch (_) { /* best-effort */ }
    return `Moved *${task.title}* to ${intent.when} (${t.dayLabel(due, tz)} 09:00). \ud83d\udcc5`;
  }

  return null;
}

function dueSuffix(task, tz) {
  if (!task.due_date) return '';
  try {
    return ` \u2014 due ${t.dayLabel(task.due_date, tz)} ${t.timeLabel(task.due_date, tz)}`;
  } catch (_) {
    return ` \u2014 due ${task.due_date}`;
  }
}

/**
 * Daily 9am nudge: if the user has tasks due today, send a WhatsApp reminder.
 */
async function sendDailyReminder(userId, { now = new Date() } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { sent: false };
  const tz = user.timezone || 'Asia/Karachi';
  const todayStart = t.startOfDayISO(tz, 0, now);
  const tomorrowStart = t.startOfDayISO(tz, 1, now);
  const due = tasksRepo.listDueBetween(user.id, todayStart, tomorrowStart);
  if (!due.length) return { sent: false, reason: 'no_tasks' };

  const lines = [`\ud83d\udccc ${due.length} task${due.length === 1 ? '' : 's'} due today:`];
  for (const task of due) lines.push(`\u2022 ${task.title}`);
  const text = lines.join('\n');

  try {
    if (wa().ready()) { await wa().sendMessage(user.phone, text); return { sent: true, text }; }
  } catch (err) { console.warn('[taskIntents] reminder failed:', err.message); }
  return { sent: false, text };
}

async function runDailyReminders({ hour = 9, now = new Date() } = {}) {
  const gate = require('../services/proactiveGate');
  const users = usersRepo.listOnboarded();
  const results = [];
  for (const u of users) {
    if (!gate.allows(u, 'taskreminder')) continue;
    const tz = u.timezone || 'Asia/Karachi';
    if (t.hourInTz(tz, now) === hour) {
      try { results.push({ phone: u.phone, ...(await sendDailyReminder(u.id, { now })) }); }
      catch (e) { console.warn('[taskIntents] failed for', u.id, e.message); }
    }
  }
  return results;
}

module.exports = { detect, handle, sendDailyReminder, runDailyReminders };
