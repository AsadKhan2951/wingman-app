'use strict';

const tasksRepo = require('../db/tasks');
const googleTasks = require('../services/googleTasks');
const t = require('../utils/time');

/** One task from task_id or a title phrase — or a clear error the model can act on. */
function pickTask(user, input = {}, { includeCompleted = false } = {}) {
  const matches = tasksRepo.findMatches(user.id, { id: input.task_id, phrase: input.query, includeCompleted });
  if (!matches.length) {
    return { error: 'TASK_NOT_FOUND', detail: 'No task matches. Call list_tasks and use the exact task_id.' };
  }
  const top = matches[0];
  const exact = (top.title || '').toLowerCase().trim() === String(input.query || '').toLowerCase().trim();
  if (!input.task_id && !exact && matches.length > 1) {
    return {
      error: 'MULTIPLE_MATCHES',
      detail: 'Several tasks match. Ask the user which one, then call again with its task_id.',
      matches: matches.slice(0, 6).map((m) => ({ task_id: m.id, title: m.title, completed: !!m.completed })),
    };
  }
  return { task: top };
}

async function executeTaskTool(user, toolUse) {
  const { name, input } = toolUse;
  const tz = user.timezone || 'Asia/Karachi';

  try {
    switch (name) {
      case 'list_tasks': {
        if (googleTasks.isConnected(user)) {
          try { await googleTasks.syncUser(user.id); } catch (_) { /* keep cached tasks */ }
        }
        const limit = Math.min(Math.max(parseInt(input.limit, 10) || 20, 1), 50);
        const rows = input.only_overdue
          ? tasksRepo.listOverdue(user.id, new Date().toISOString()).slice(0, limit)
          : tasksRepo.listForUser(user.id, {
            includeCompleted: !!input.include_completed,
            limit,
          });
        return {
          google_tasks_connected: googleTasks.isConnected(user),
          count: rows.length,
          tasks: rows.map((task) => ({
            id: task.id,
            title: task.title,
            due_date: task.due_date || null,
            due_label: task.due_date ? `${t.dayLabel(task.due_date, tz)} ${t.timeLabel(task.due_date, tz)}` : null,
            completed: !!task.completed,
            source: task.source || 'manual',
          })),
        };
      }

      case 'create_task': {
        const created = tasksRepo.create({
          userId: user.id,
          title: input.title,
          source: 'whatsapp',
          priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 3,
          dueDate: input.due_date || null,
        });
        let sync = { synced: false, reason: 'NOT_CONNECTED' };
        try { sync = await googleTasks.mirrorNewLocalTask(created.id); } catch (err) {
          sync = { synced: false, reason: err.message || 'SYNC_FAILED' };
        }
        return {
          created: true,
          task: {
            id: created.id,
            title: created.title,
            due_date: created.due_date || null,
            due_label: created.due_date ? `${t.dayLabel(created.due_date, tz)} ${t.timeLabel(created.due_date, tz)}` : null,
          },
          google_tasks_connected: googleTasks.isConnected(user),
          synced_to_google_tasks: !!sync.synced,
          google_account_email: sync.accountEmail || null,
          sync_reason: sync.reason || null,
        };
      }

      case 'complete_task': {
        // Closes the task, its duplicates, its reminder automations and a
        // matching goal step — so a "done" task never gets reminded again.
        const r = await require('../services/taskDone').complete(user, {
          query: input.query || '', taskId: input.task_id || null, all: !!input.all,
        });
        if (r.completed && r.tasks && r.tasks[0]) r.task = { id: r.tasks[0].task_id, title: r.tasks[0].title };
        return r;
      }

      case 'move_task': {
        const task = tasksRepo.findByTitle(user.id, input.query || '');
        if (!task) return { error: 'TASK_NOT_FOUND' };
        const updated = tasksRepo.updateDueDate(task.id, input.due_date || null);
        let sync = { synced: false, reason: 'NOT_CONNECTED' };
        try { sync = await googleTasks.mirrorTaskUpdate(task.id); } catch (err) {
          sync = { synced: false, reason: err.message || 'SYNC_FAILED' };
        }
        return {
          moved: true,
          task: {
            id: updated.id,
            title: updated.title,
            due_date: updated.due_date || null,
            due_label: updated.due_date ? `${t.dayLabel(updated.due_date, tz)} ${t.timeLabel(updated.due_date, tz)}` : null,
          },
          synced_to_google_tasks: !!sync.synced,
          google_account_email: sync.accountEmail || null,
          sync_reason: sync.reason || null,
        };
      }

      case 'delete_task': {
        const found = pickTask(user, input, { includeCompleted: true });
        if (found.error) return found;
        const task = found.task;
        // Remove it from Google first, so the next sync can't bring it back.
        let removedRemote = false;
        if (task.google_task_id) removedRemote = await googleTasks.mirrorTaskDeletion(task);
        tasksRepo.remove(task.id);
        return {
          deleted: true,
          task: { id: task.id, title: task.title },
          removed_from_google_tasks: task.google_task_id ? removedRemote : null,
        };
      }

      case 'update_task': {
        const found = pickTask(user, input, { includeCompleted: false });
        if (found.error) return found;
        const clearDue = String(input.due_date || '').toLowerCase() === 'none';
        const updated = tasksRepo.updateFields(found.task.id, {
          title: input.title,
          priority: input.priority,
          dueDate: clearDue ? null : (input.due_date ? input.due_date : undefined),
        });
        let sync = { synced: false, reason: 'NOT_CONNECTED' };
        try { sync = await googleTasks.mirrorTaskUpdate(updated.id); } catch (err) {
          sync = { synced: false, reason: err.message || 'SYNC_FAILED' };
        }
        return {
          updated: true,
          task: {
            id: updated.id,
            title: updated.title,
            priority: updated.priority,
            due_date: updated.due_date || null,
            due_label: updated.due_date ? `${t.dayLabel(updated.due_date, tz)} ${t.timeLabel(updated.due_date, tz)}` : null,
          },
          synced_to_google_tasks: !!sync.synced,
          sync_reason: sync.reason || null,
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: (err && err.message) || 'task_operation_failed' };
  }
}

module.exports = { executeTaskTool };
