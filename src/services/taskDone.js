'use strict';

/**
 * "Done" means done — everywhere.
 *
 * When the user says a task is done, everything that would keep reminding them
 * about it must stop, or Wingman says "marked done" and then nags again:
 *   - the task itself, AND any duplicate rows of it (same title — a task added
 *     twice, or once by chat and once by the Google Tasks import),
 *   - one-off / reminder automations whose instruction is about that task,
 *   - a matching step of an active goal (the daily goal nudge).
 * The result says exactly what was closed; when nothing matched it says so, so
 * the assistant never claims "done" for something still open.
 */

const { db } = require('../db');
const tasksRepo = require('../db/tasks');

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const keyWords = (s) => (norm(s).match(/[\p{L}\p{N}]{3,}/gu) || [])
  .filter((w) => !['the', 'and', 'for', 'with', 'task', 'remind', 'reminder', 'please', 'today', 'tomorrow'].includes(w));

/** Reminder automations about this task → switched off. */
function stopReminders(userId, title) {
  const tw = keyWords(title);
  if (!tw.length) return [];
  const rows = db.prepare('SELECT id, instruction, kind FROM automations WHERE user_id = ? AND active = 1').all(userId);
  const stopped = [];
  for (const a of rows) {
    const ins = norm(a.instruction);
    const isReminder = a.kind === 'once' || /\bremind/.test(ins) || /\byaad\b/.test(ins);
    if (!isReminder) continue;
    const hit = tw.filter((w) => ins.includes(w)).length;
    if (hit / tw.length >= 0.6) {
      db.prepare('UPDATE automations SET active = 0 WHERE id = ? AND user_id = ?').run(a.id, userId);
      stopped.push(a.instruction);
    }
  }
  return stopped;
}

async function mirror(taskId) {
  try { return await require('./googleTasks').mirrorTaskCompletion(taskId); } catch (err) { return { synced: false, reason: err.message }; }
}

/**
 * @param {object} user
 * @param {{ query?: string, taskId?: string, all?: boolean }} opts
 */
async function complete(user, { query = '', taskId = null, all = false } = {}) {
  let matches = taskId
    ? tasksRepo.findMatches(user.id, { id: taskId }).filter((t) => !t.completed)
    : tasksRepo.findMatches(user.id, { phrase: query });

  if (!matches.length) {
    // Maybe it's the step of a goal they were nudged about.
    if (query) {
      const goals = require('../db/goals');
      for (const g of goals.listActive(user.id)) {
        const r = goals.markSteps(g.id, { text: query });
        if (r.marked.length) {
          return { completed: true, goal: g.title, goal_steps_done: r.marked, tasks: [] };
        }
      }
    }
    const open = tasksRepo.listForUser(user.id, { includeCompleted: false, limit: 15 });
    return {
      error: 'TASK_NOT_FOUND',
      detail: 'Nothing was marked done. Do NOT tell the user it is done. Show them the open tasks below and ask which one, then call again with its task_id.',
      open_tasks: open.map((t) => ({ task_id: t.id, title: t.title })),
    };
  }

  // The best match and every duplicate of it (same title).
  const top = matches[0];
  let group = matches.filter((t) => norm(t.title) === norm(top.title));
  if (!taskId && !all) {
    const rivals = matches.filter((t) => norm(t.title) !== norm(top.title));
    const topScore = norm(top.title) === norm(query) ? 2 : (norm(top.title).includes(norm(query)) || norm(query).includes(norm(top.title)) ? 1 : 0);
    const tie = rivals.filter((t) => {
      const s = norm(t.title) === norm(query) ? 2 : (norm(t.title).includes(norm(query)) || norm(query).includes(norm(t.title)) ? 1 : 0);
      return s === topScore;
    });
    if (tie.length && topScore < 2) {
      return {
        error: 'MULTIPLE_MATCHES',
        detail: 'Several different tasks match — nothing was marked yet. Ask which one (or "all of them"), then call again with task_id (or all: true).',
        matches: [top, ...tie].slice(0, 6).map((t) => ({ task_id: t.id, title: t.title })),
      };
    }
  }
  if (all) group = matches;
  // Duplicates of the chosen task (same title — e.g. the Google Tasks copy) close with it.
  if (taskId) {
    const same = tasksRepo.listForUser(user.id, { includeCompleted: false, limit: 500 })
      .filter((t) => t.id !== top.id && norm(t.title) === norm(top.title));
    group = [top, ...same];
  }

  const done = [];
  let synced = true;
  for (const t of group) {
    tasksRepo.complete(t.id);
    const s = await mirror(t.id);
    if (s && s.synced === false && s.reason !== 'NOT_CONNECTED') synced = false;
    done.push({ task_id: t.id, title: t.title });
  }
  const stopped = [...new Set(group.flatMap((t) => stopReminders(user.id, t.title)))];

  // Also tick a matching goal step, so the daily goal nudge moves on.
  const goalSteps = [];
  try {
    const goals = require('../db/goals');
    for (const g of goals.listActive(user.id)) {
      const r = goals.markSteps(g.id, { text: top.title });
      goalSteps.push(...r.marked);
    }
  } catch (_) { /* optional */ }

  return {
    completed: true,
    tasks: done,
    duplicates_closed: Math.max(0, done.length - 1),
    stopped_reminders: stopped,
    goal_steps_done: goalSteps,
    synced_to_google_tasks: synced,
  };
}

module.exports = { complete, stopReminders };
