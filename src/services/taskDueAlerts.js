'use strict';

const usersRepo = require('../db/users');
const tasksRepo = require('../db/tasks');
const proactiveGate = require('./proactiveGate');
const t = require('../utils/time');

function wa() { return require('../whatsapp/client'); }

const PREF_KEY = 'taskDueAlerts';

function buildMessage(user, task) {
  const tz = user.timezone || 'Asia/Karachi';
  const at = task.due_date ? t.timeLabel(task.due_date, tz) : null;
  const title = task.title || 'Untitled task';
  const code = require('../utils/language').userLanguage(user);
  const lang = code === 'arabic' ? 'ar' : (/urdu/.test(code) ? 'ur' : 'en');

  if (lang === 'ur') {
    return [
      `Reminder: *${title}*`,
      at ? `Ye task taqreeban 15 minute baad hai - ${at}.` : 'Ye task taqreeban 15 minute baad hai.',
    ].join('\n');
  }

  if (lang === 'ar') {
    return [
      `تذكير: *${title}*`,
      at ? `هذا الموعد بعد حوالي 15 دقيقة - ${at}.` : 'هذا الموعد بعد حوالي 15 دقيقة.',
    ].join('\n');
  }

  return [
    `Reminder: *${title}*`,
    at ? `This task is due in about 15 minutes - ${at}.` : 'This task is due in about 15 minutes.',
  ].join('\n');
}

function dueSoonTasks(user, now = new Date(), windowMin = 15) {
  const end = now.getTime() + windowMin * 60000;
  const rows = tasksRepo.listForUser(user.id, { includeCompleted: false, limit: 500 });
  return rows.filter((task) => {
    if (!task.due_date) return false;
    const dueMs = new Date(task.due_date).getTime();
    if (Number.isNaN(dueMs)) return false;
    return dueMs >= now.getTime() && dueMs < end;
  });
}

function reminderState(user) {
  const prefs = user.preferences || {};
  const raw = prefs[PREF_KEY];
  return raw && typeof raw === 'object' ? { ...raw } : {};
}

function pruneState(state, maxEntries = 200) {
  const entries = Object.entries(state);
  if (entries.length <= maxEntries) return state;
  return Object.fromEntries(entries.slice(entries.length - maxEntries));
}

function rememberDue(userId, taskId, dueDate) {
  const user = usersRepo.getById(userId);
  if (!user) return null;
  const prefs = { ...(user.preferences || {}) };
  const state = reminderState(user);
  state[taskId] = dueDate;
  prefs[PREF_KEY] = pruneState(state);
  usersRepo.update(userId, { preferences: prefs });
  return state;
}

async function alertForUser(userId, { now = new Date(), send = true, windowMin = 15 } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { sent: [] };
  if (!proactiveGate.allows(user, 'taskdue')) return { sent: [], skipped: 'gated' };

  const already = reminderState(user);
  // Never remind about something they already said is done.
  try { if (send) await require('./doneGuard').reconcile(user); } catch (_) { /* best-effort */ }
  const dueSoon = dueSoonTasks(user, now, windowMin);
  const sent = [];

  for (const task of dueSoon) {
    if (already[task.id] === task.due_date) continue;

    const msg = buildMessage(user, task);
    rememberDue(user.id, task.id, task.due_date);
    sent.push(msg);

    if (!send) continue;
    try {
      await wa().sendProactiveMessage(user, msg, { now, logLabel: 'taskdue' });
    } catch (err) {
      console.warn('[taskDueAlerts] send failed:', err.message);
    }
  }

  return { sent };
}

async function runAllUsers({ now = new Date(), send = true, windowMin = 15 } = {}) {
  const users = usersRepo.listOnboarded();
  const results = [];
  for (const user of users) {
    try {
      const r = await alertForUser(user.id, { now, send, windowMin });
      if (r.sent && r.sent.length) results.push({ phone: user.phone, count: r.sent.length });
    } catch (err) {
      console.warn('[taskDueAlerts] failed for', user.phone, err.message);
    }
  }
  return results;
}

module.exports = { buildMessage, dueSoonTasks, alertForUser, runAllUsers };
