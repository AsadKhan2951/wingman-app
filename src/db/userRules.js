'use strict';

const { db, uuid } = require('./index');

/**
 * Standing rules a user gave Wingman about how to behave ("don't ask me for
 * this", "don't tell me about that"). Synchronous — never await these.
 */

// behavior = how to talk/act ("keep replies short", "no emojis", "never call me
// sir", "always reply in Roman Urdu") — the user's own corrections, kept forever.
const KINDS = new Set(['auto_approve', 'always_ask', 'notify_mute', 'notify_always', 'behavior']);
const MAX_RULES = 40;

function listForUser(userId) {
  return db.prepare('SELECT * FROM user_rules WHERE user_id = ? ORDER BY created_at').all(userId);
}

function add(userId, { kind, text, toolkit = null, toolSlug = null, scope = null }) {
  if (!KINDS.has(kind)) return { added: false, reason: 'bad_kind' };
  const t = String(text || '').trim().slice(0, 300);
  if (!t) return { added: false, reason: 'empty' };
  const rows = listForUser(userId);
  const dupe = rows.find((r) => r.kind === kind && (r.tool_slug || '') === (toolSlug || '') &&
    (r.scope || '') === (scope || '') && r.text.toLowerCase() === t.toLowerCase());
  if (dupe) return { added: false, id: dupe.id, reason: 'duplicate' };
  if (rows.length >= MAX_RULES) return { added: false, reason: 'too_many' };
  const id = uuid();
  db.prepare(`
    INSERT INTO user_rules (id, user_id, kind, toolkit, tool_slug, text, scope) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, kind, toolkit, toolSlug, t, scope);
  return { added: true, id };
}

/** Remove by id, or every rule whose text/tool mentions `about`. */
function remove(userId, { id, about } = {}) {
  if (id) {
    return db.prepare('DELETE FROM user_rules WHERE id = ? AND user_id = ?').run(id, userId).changes;
  }
  const like = `%${String(about || '').toLowerCase()}%`;
  if (like === '%%') return 0;
  return db.prepare(
    "DELETE FROM user_rules WHERE user_id = ? AND (LOWER(text) LIKE ? OR LOWER(COALESCE(tool_slug,'')) LIKE ?)",
  ).run(userId, like, like).changes;
}

/** Has the user said this exact app tool may run without asking? */
function hasAutoApprove(userId, toolSlug) {
  return !!db.prepare(
    "SELECT 1 FROM user_rules WHERE user_id = ? AND kind = 'auto_approve' AND tool_slug = ? AND scope IS NULL LIMIT 1",
  ).get(userId, toolSlug);
}

module.exports = { KINDS, listForUser, add, remove, hasAutoApprove };
