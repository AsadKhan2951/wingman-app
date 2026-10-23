'use strict';

/**
 * Hard guards so "done" is enforced in CODE, not left to the chat model.
 *
 * Works in ANY language: a small, cheap model JUDGES each turn — "did the user
 * say they finished one of these open tasks?" (done / ho gaya / kar diya /
 * erledigt / terminé / تم … or a mix) and "does the reply claim something was
 * marked done?". No word lists decide it. The code then acts on the verdict:
 *
 *  afterReply(user, userText, reply, ctx)
 *    After every chat turn. Tasks the user said are done are closed (with their
 *    duplicates + reminders) even if the chat model forgot the tool. A reply
 *    that claims "marked done" when nothing was closed is replaced by an honest
 *    "which one?". A reply in the wrong language is rewritten.
 *
 *  reconcile(user)
 *    Before any reminder / briefing / nudge: user messages since the last check
 *    are judged the same way, so a task they already said is done is closed
 *    before it can be reminded again.
 *
 *  fixLanguage(user, text)
 *    Proactive messages are checked against the language the user writes in.
 *
 * If the judge is unavailable (API error) a simple keyword fallback is used,
 * so the guard degrades, never disappears.
 */

const { db } = require('../db');
const tasksRepo = require('../db/tasks');
const usersRepo = require('../db/users');
const L = require('../utils/language');

// ── The judge (language-agnostic) ───────────────────────────────────

let llm = null; // test hook
function model() {
  return llm || ((prompt, opts) => require('../llm/claude').complete(prompt, { ...opts, model: require('../config').anthropic.modelCheap }));
}

function parseJson(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

const JUDGE_SYSTEM = `You check a personal assistant's work. The user may write in ANY language, script or mix (English, Roman Urdu, Urdu, Arabic, Hindi, German, Spanish …), with typos and shorthand.
Return ONLY JSON.
Rules for "done":
- A task counts as done ONLY when the user clearly says THEY finished it (e.g. "done", "ho gaya", "kar diya", "erledigt", "terminé", "خلاص", "all 3 done", "finished the report").
- NOT done: questions ("is it done?"), plans or conditions ("once done…", "will do"), negatives ("not yet", "abhi nahi hua"), someone else's work, or "done" about something that is not in the task list.
- Match by meaning, not exact words ("EMB bug fixing done" = "EMB curves more bug fixing"). If it is unclear which task, return none.
- Use only task ids from the list.`;

/**
 * @returns {Promise<{done_ids:string[], reply_claims_done:boolean, reply_language_ok:boolean}|null>}
 */
async function judgeTurn(user, { userText, reply, open }) {
  const lang = L.languageLabel(user);
  const prompt = `OPEN TASKS:\n${open.map((t) => `- ${t.id} | ${t.title}`).join('\n') || '(none)'}\n\n`
    + `USER'S MESSAGE:\n${userText}\n\nASSISTANT'S REPLY:\n${reply}\n\n`
    + `The user writes in: ${lang}.\n`
    + 'Return {"done_ids":[ids the user says are finished],"reply_claims_done":true if the reply says a task was marked done/completed/closed,"reply_language_ok":false only if the reply is clearly in a different language than the user writes in}';
  try {
    const j = parseJson(await model()(prompt, { system: JUDGE_SYSTEM, maxTokens: 200 }));
    if (!j) return null;
    const ids = new Set(open.map((t) => t.id));
    return {
      done_ids: (Array.isArray(j.done_ids) ? j.done_ids : []).map(String).filter((id) => ids.has(id)),
      reply_claims_done: !!j.reply_claims_done,
      reply_language_ok: j.reply_language_ok !== false,
    };
  } catch (e) {
    console.warn('[doneGuard] judge failed:', e.message);
    return null;
  }
}

async function judgeMessages(user, { messages, open }) {
  const prompt = `OPEN TASKS (id | title | created):\n${open.map((t) => `- ${t.id} | ${t.title} | ${t.created_at}`).join('\n')}\n\n`
    + `USER'S RECENT MESSAGES (time | text):\n${messages.map((m) => `- ${m.created_at} | ${String(m.content).slice(0, 400)}`).join('\n')}\n\n`
    + 'Which open tasks did the user say they finished? Only count a message sent AFTER the task was created. Return {"done_ids":[...]}';
  try {
    const j = parseJson(await model()(prompt, { system: JUDGE_SYSTEM, maxTokens: 200 }));
    if (!j) return null;
    const ids = new Set(open.map((t) => t.id));
    return (Array.isArray(j.done_ids) ? j.done_ids : []).map(String).filter((id) => ids.has(id));
  } catch (e) {
    console.warn('[doneGuard] judge failed:', e.message);
    return null;
  }
}

// ── Fallback only (judge unavailable) ───────────────────────────────

const FALLBACK_DONE = /\b(done|completed?|finished|ho\s*gay[ai]|hogay[ai]|kar\s*diy[ai]|kr\s*diy[ai])\b|✅/i;
const FALLBACK_NOT = /\b(not|nahi|nhi|when|once|after)\b|\?\s*$/i;
const FALLBACK_CLAIM = /\b(marked?\s+(as\s+)?(done|complete[d]?)|ticked\s+off|mark\s+kar\s+diya)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'task', 'remind', 'reminder', 'please', 'today', 'tomorrow', 'done', 'completed', 'complete', 'finished', 'mark', 'marked', 'kar', 'diya', 'gaya', 'hogaya', 'that', 'this', 'its', 'has', 'have', 'been', 'also', 'more']);
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const keyWords = (s) => (norm(s).match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w));
function coverage(title, text) {
  const tw = [...new Set(keyWords(title))];
  if (!tw.length) return 0;
  const mw = new Set(keyWords(text));
  return tw.filter((w) => mw.has(w)).length / tw.length;
}
function fallbackIds(open, text) {
  if (!FALLBACK_DONE.test(text) || FALLBACK_NOT.test(text)) return [];
  const hits = open.map((t) => ({ t, c: coverage(t.title, text) })).filter((x) => x.c >= 0.75 && keyWords(x.t.title).length >= 2).sort((a, b) => b.c - a.c);
  if (!hits.length) return [];
  const top = hits.filter((h) => h.c === hits[0].c);
  return new Set(top.map((h) => norm(h.t.title))).size === 1 ? [top[0].t.id] : [];
}

// ── Acting on the verdict ───────────────────────────────────────────

const openTasks = (userId) => db.prepare('SELECT id, title, created_at FROM tasks WHERE user_id = ? AND completed = 0 ORDER BY created_at DESC LIMIT 60').all(userId);

async function closeIds(user, ids) {
  const closed = [];
  const taskDone = require('./taskDone');
  for (const id of ids) {
    const t = tasksRepo.getById(id);
    if (!t || t.completed) continue; // already closed (e.g. as a duplicate)
    const r = await taskDone.complete(user, { taskId: id });
    if (r.completed) closed.push(...r.tasks);
  }
  return closed;
}

async function afterReply(user, userText, reply, ctx = {}) {
  const open = openTasks(user.id);
  let out = String(reply || '');

  if (!open.length) {
    // No tasks to judge: only the cheap language check (English writer got Roman Urdu).
    return (/^english$/i.test(L.languageLabel(user)) && L.looksRomanUrdu(out)) ? translate(user, out) : out;
  }

  let verdict = await judgeTurn(user, { userText, reply: out, open });
  if (!verdict) {
    verdict = { done_ids: fallbackIds(open, userText), reply_claims_done: FALLBACK_CLAIM.test(out), reply_language_ok: true };
  }

  let closed = [];
  try { closed = await closeIds(user, verdict.done_ids); } catch (e) { console.warn('[doneGuard]', e.message); }
  if (closed.length) console.log(`[doneGuard] closed in code for user ${user.id}: ${closed.map((t) => t.title).join(', ')}`);

  if (closed.length && !verdict.reply_claims_done) {
    out = `${out.trim()}\n\n✅ ${closed.map((t) => t.title).join(', ')}`.trim();
  } else if (verdict.reply_claims_done && !closed.length && !ctx.closedSomething) {
    // The reply says "marked done" but nothing was closed — never send that.
    const left = openTasks(user.id).slice(0, 6);
    out = left.length
      ? `Which one should I mark done? I couldn't find an exact match:\n${left.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}\n\nReply with the number or name.`
      : "I couldn't find an open task to close — everything is already done.";
    return /^english$/i.test(L.languageLabel(user)) ? out : translate(user, out);
  }

  if (!verdict.reply_language_ok) return translate(user, out);
  return out;
}

/** Judge the user's messages since the last check and close what they said is done. */
async function reconcile(user, { hours = 48 } = {}) {
  if (!user) return [];
  const fresh = usersRepo.getById(user.id) || user;
  const prefs = fresh.preferences || {};
  const floor = new Date(Date.now() - hours * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  const since = prefs.doneGuardAt && prefs.doneGuardAt > floor ? prefs.doneGuardAt : floor;
  let msgs = [];
  try {
    msgs = db.prepare("SELECT content, created_at FROM conversations WHERE user_id = ? AND role = 'user' AND created_at > ? AND content IS NOT NULL ORDER BY created_at ASC LIMIT 40").all(user.id, since);
  } catch (_) { return []; }
  msgs = msgs.filter((m) => String(m.content).trim() && !/^\[/.test(String(m.content).trim()));
  if (!msgs.length) return [];
  const open = openTasks(user.id);
  if (!open.length) return [];

  let ids = await judgeMessages(user, { messages: msgs, open });
  if (ids === null) {
    ids = [];
    for (const m of msgs) ids.push(...fallbackIds(open.filter((t) => String(t.created_at) <= String(m.created_at)), m.content));
  } else {
    // Only remember the cursor when the judge actually ran.
    try { usersRepo.updatePreferences(user.id, { doneGuardAt: msgs[msgs.length - 1].created_at }); } catch (_) { /* best-effort */ }
  }
  const closed = await closeIds(fresh, [...new Set(ids)]);
  if (closed.length) console.log(`[doneGuard] reconciled for user ${user.id}: ${closed.map((t) => t.title).join(', ')}`);
  return closed;
}

// ── Language ────────────────────────────────────────────────────────

async function translate(user, text) {
  const lang = L.languageLabel(user);
  try {
    const out = await model()(
      `Write this WhatsApp message in ${lang}. If it is already in ${lang}, return it unchanged. Keep the meaning, names, numbers, emoji, line breaks and *bold*. Return ONLY the message.\n\n${text}`,
      { maxTokens: 800 },
    );
    return (out && out.trim()) || text;
  } catch (_) { return text; }
}

/** Any outgoing message → the language the user actually writes in. */
async function fixLanguage(user, text) {
  const s = String(text || '');
  if (!s.trim()) return s;
  const lang = L.languageLabel(user);
  // Cheap path: English user, plain English-looking text → nothing to do.
  if (/^english$/i.test(lang) && !L.looksRomanUrdu(s) && !/[^\u0000-\u024F\s\p{Emoji}\p{P}\p{S}\p{N}]/u.test(s)) return s;
  // Roman Urdu user + Latin text, Urdu user + Urdu script, etc. are left to the judge in chat;
  // for proactive messages (few a day) we always let the model check.
  return translate(user, s);
}

module.exports = {
  afterReply, reconcile, fixLanguage,
  _setModel: (fn) => { llm = fn; },
  _fallbackIds: fallbackIds,
};
