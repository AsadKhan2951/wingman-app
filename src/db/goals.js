'use strict';

const { db, uuid } = require('./index');

/**
 * Goals — longer-term things the user is working toward. Each goal carries an
 * AI-built action plan (JSON array of { step, done }) and a progress %, and is
 * coached proactively by src/services/goalCoach.js. Distinct from tasks (a task
 * is a single to-do; a goal spans days/weeks with multiple steps).
 */

function parsePlan(row) {
  if (!row) return row;
  try { row.plan = JSON.parse(row.plan || '[]'); } catch (_) { row.plan = []; }
  if (!Array.isArray(row.plan)) row.plan = [];
  return row;
}

function create(userId, { title, detail = null, plan = [], targetDate = null } = {}) {
  if (!title) throw new Error('title required');
  const id = uuid();
  db.prepare(`
    INSERT INTO goals (id, user_id, title, detail, plan, target_date, progress, status)
    VALUES (@id, @userId, @title, @detail, @plan, @targetDate, 0, 'active')
  `).run({ id, userId, title, detail, plan: JSON.stringify(Array.isArray(plan) ? plan : []), targetDate });
  return getById(id);
}

function getById(id) {
  return parsePlan(db.prepare('SELECT * FROM goals WHERE id = ?').get(id) || null);
}

function getForUser(userId, id) {
  return parsePlan(db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(id, userId) || null);
}

function listForUser(userId, { status = null, limit = 50 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM goals WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(userId, status, limit)
    : db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  return rows.map(parsePlan);
}

function listActive(userId) {
  return listForUser(userId, { status: 'active' });
}

/** Fuzzy-match an active goal by title (for chat: "how's my tennis goal"). */
function findByTitle(userId, phrase) {
  const p = String(phrase || '').toLowerCase().trim();
  if (!p) return null;
  const rows = db.prepare("SELECT * FROM goals WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC").all(userId);
  let match = rows.find((r) => {
    const n = (r.title || '').toLowerCase();
    return n.includes(p) || p.includes(n);
  });
  if (!match) {
    const words = p.split(/\s+/).filter((w) => w.length > 2);
    match = rows.find((r) => words.some((w) => (r.title || '').toLowerCase().includes(w)));
  }
  return parsePlan(match || null);
}

const FIELDS = {
  title: 'title', detail: 'detail', status: 'status',
  targetDate: 'target_date', lastNudgeAt: 'last_nudge_at',
};

function update(id, patch = {}) {
  const owned = db.prepare('SELECT id FROM goals WHERE id = ?').get(id);
  if (!owned) return null;
  const sets = [];
  const vals = { id };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'plan') { sets.push('plan = @plan'); vals.plan = JSON.stringify(Array.isArray(v) ? v : []); continue; }
    if (k === 'progress') { sets.push('progress = @progress'); vals.progress = Math.max(0, Math.min(100, Number(v) || 0)); continue; }
    const col = FIELDS[k];
    if (!col) continue;
    sets.push(`${col} = @${col}`);
    vals[col] = v == null ? null : v;
  }
  if (!sets.length) return getById(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  return getById(id);
}

/** Mark a plan step done (by text match or index) and recompute progress %. */
/**
 * Mark plan steps done by text (forgiving: exact/substring, else most shared
 * words) and/or the next unfinished step. Returns { goal, marked: [step text] }
 * so callers never claim "done" when nothing matched.
 */
function markSteps(id, { text = null, next = false } = {}) {
  const g = getById(id);
  if (!g) return { goal: null, marked: [] };
  const plan = g.plan || [];
  const marked = [];
  const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  if (text) {
    const q = String(text).toLowerCase().trim();
    let idx = plan.findIndex((s) => !s.done && (String(s.step).toLowerCase().includes(q) || q.includes(String(s.step).toLowerCase())));
    if (idx === -1) {
      const qw = new Set(words(q));
      let best = -1;
      let bestScore = 0;
      plan.forEach((s, i) => {
        if (s.done || !qw.size) return;
        const sw = words(s.step);
        const hit = sw.filter((w) => qw.has(w)).length;
        const score = hit / Math.max(1, Math.min(sw.length, qw.size));
        if (hit >= 2 && score > bestScore) { best = i; bestScore = score; }
      });
      if (bestScore >= 0.4) idx = best;
    }
    if (idx !== -1) { plan[idx].done = true; marked.push(plan[idx].step); }
  }
  if (next && !marked.length) {
    const idx = plan.findIndex((s) => !s.done);
    if (idx !== -1) { plan[idx].done = true; marked.push(plan[idx].step); }
  }
  if (!marked.length) return { goal: g, marked };
  const total = plan.length || 1;
  const doneCount = plan.filter((s) => s.done).length;
  return { goal: update(id, { plan, progress: Math.round((doneCount / total) * 100) }), marked };
}

function setStepDone(id, stepMatch, done = true) {
  const g = getById(id);
  if (!g) return null;
  const plan = g.plan || [];
  for (let i = 0; i < plan.length; i++) {
    const label = String(plan[i].step || '').toLowerCase();
    const byIndex = typeof stepMatch === 'number' && i === stepMatch;
    const byText = typeof stepMatch === 'string' && stepMatch
      && (label.includes(stepMatch.toLowerCase()) || stepMatch.toLowerCase().includes(label));
    if (byIndex || byText) plan[i].done = !!done;
  }
  const total = plan.length || 1;
  const doneCount = plan.filter((s) => s.done).length;
  return update(id, { plan, progress: Math.round((doneCount / total) * 100) });
}

function remove(userId, id) {
  return db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

module.exports = {
  create, getById, getForUser, listForUser, listActive, findByTitle, update, setStepDone, markSteps, remove,
};
