'use strict';

/**
 * Replies ready before the user asks — the chief-of-staff inbox.
 *
 * For every email that needs the user (urgent / needs a reply) and hasn't been
 * answered, Wingman reads the full message and drafts the reply AS the user:
 * their style (styleProfile), their priorities and people (Operating Manual),
 * their rules. The draft waits on the email (email_items.prepared_reply); the
 * user just says "send it" / "haan bhej do" — or edits it. Nothing is sent from
 * here: sending goes through the normal reply tools and approval gate (and the
 * user's earned "do without asking" rules).
 *
 * If a reply needs something only the user knows (a price, a date, a yes/no),
 * the draft leaves a [bracketed gap] and prepared_note asks for it.
 */

const { db } = require('../db');
const usersRepo = require('../db/users');
const emailItems = require('../db/emailItems');

const PER_USER_PER_TICK = 4;
const PER_TICK = 20;
const LOOKBACK_DAYS = 3;
const NO_REPLY = /(no-?reply|do-?not-?reply|notifications?@|mailer-daemon|newsletter|noreply|bounce|alerts?@|updates?@|support@.*(google|amazon|apple)\.)/i;

const SYSTEM = `You draft an email reply AS the person below — they will send it under their own name, so it must read exactly as if they wrote it. You are their chief of staff: you know their priorities, their people and how they write.

Reply with ONLY compact JSON, no prose, no code fences:
{"reply": "the full reply body (no subject line)", "needs_input": "one short question for them if the reply needs a fact or decision only they have, else null", "skip": false}

Rules:
- Write in THEIR voice: their greeting, sign-off, length, language and tone (see HOW THEY WRITE). If unknown: short, warm, direct, signed with their first name.
- Answer what the email actually asks. No filler, no "I hope this email finds you well" unless they write like that.
- NEVER invent facts, prices, dates, commitments or attachments. Where a fact or decision is needed, leave a clear gap like [price] or [yes/no — can we do Thursday?] and put the question in needs_input.
- Promise nothing that costs money or time beyond what the email and their notes support.
- If the email doesn't need a reply from them (automated, FYI, a thank-you that closes the thread, a newsletter), return {"reply": "", "needs_input": null, "skip": true}.`;

function contextFor(user) {
  const parts = [];
  parts.push(`THEM: ${user.name || '(unknown)'}${user.webmail_address ? ` · business address ${user.webmail_address}` : ''}`);
  try { const s = require('./styleProfile').promptBlock(user); if (s) parts.push(`HOW THEY WRITE:${s}`); } catch (_) { /* optional */ }
  try { const m = require('./userProfile').card(user); if (m) parts.push(`THEIR OPERATING MANUAL:\n${m.slice(0, 1800)}`); } catch (_) { /* optional */ }
  try {
    const rules = require('../db/userRules').listForUser(user.id).filter((r) => r.kind === 'behavior');
    if (rules.length) parts.push(`THEIR RULES FOR YOU:\n${rules.map((r) => `- ${r.text}`).join('\n')}`);
  } catch (_) { /* optional */ }
  return parts.join('\n\n');
}

/** Full text of the email, from Gmail or the business mailbox. */
async function fetchBody(user, item) {
  const id = String(item.gmail_id || '');
  if (id.startsWith('webmail:')) {
    const m = await require('./webmail').readMessage(user, parseInt(id.slice(8), 10));
    return m ? { from: m.from, subject: m.subject, body: m.body } : null;
  }
  const gmail = require('./gmail');
  let account = null;
  try { if (item.account_id) account = require('../db/googleAccounts').listForUser(user.id).find((a) => a.id === item.account_id) || null; } catch (_) { /* default */ }
  const m = await gmail.getMessage(user, id, account);
  return m ? { from: m.sender, subject: m.subject, body: m.body } : null;
}

function parse(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { return null; }
}

/** Draft one reply. Returns { drafted } | { skipped } | { error }. */
async function draftFor(user, item, { llm } = {}) {
  let mail;
  try { mail = await fetchBody(user, item); } catch (err) {
    const gc = require('./googleConnection');
    if (gc.isAuthError(err)) gc.markBroken(user, { reason: 'gmail' });
    return { error: String(err.message || err).slice(0, 120) };
  }
  if (!mail || !String(mail.body || '').trim()) return { skipped: 'no_body' };
  const prompt = `${contextFor(user)}\n\nTHE EMAIL TO ANSWER\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${String(mail.body).slice(0, 5000)}`;
  const complete = llm || ((p, o) => require('../llm/claude').complete(p, o));
  let out;
  try { out = parse(await complete(prompt, { system: SYSTEM, maxTokens: 900 })); } catch (err) { return { error: err.message }; }
  if (!out) return { error: 'unparseable' };
  if (out.skip || !String(out.reply || '').trim()) {
    // Mark so we don't try again every hour.
    emailItems.setPrepared(user.id, item.id, { reply: null, note: 'no reply needed' });
    db.prepare("UPDATE email_items SET prepared_at = datetime('now') WHERE id = ?").run(item.id);
    return { skipped: 'no_reply_needed' };
  }
  emailItems.setPrepared(user.id, item.id, { reply: String(out.reply).trim().slice(0, 4000), note: out.needs_input ? String(out.needs_input).slice(0, 300) : null });
  return { drafted: true };
}

/** Emails that need a reply, unanswered, not yet drafted. */
function candidates(userId, limit = PER_USER_PER_TICK) {
  return db.prepare(`
    SELECT * FROM email_items
    WHERE user_id = ? AND replied = 0 AND prepared_at IS NULL
      AND (category IN ('urgent', 'needs_reply') OR action_needed = 1)
      AND COALESCE(received_at, created_at) >= ?
    ORDER BY COALESCE(received_at, created_at) DESC LIMIT ?
  `).all(userId, new Date(Date.now() - LOOKBACK_DAYS * 86400e3).toISOString().replace('T', ' ').slice(0, 19), limit * 3)
    .filter((r) => !NO_REPLY.test(String(r.sender || '')))
    .slice(0, limit);
}

/** Hourly: draft replies for a few emails per user. */
async function runDue({ llm } = {}) {
  let made = 0;
  for (const u of usersRepo.listOnboarded()) {
    if (made >= PER_TICK) break;
    const user = usersRepo.getById(u.id);
    const hasMail = require('../auth/googleAuth').isEmailConnected(user) || require('./webmail').isConnected(user);
    if (!hasMail || require('./googleConnection').isBroken(user)) continue;
    for (const item of candidates(user.id)) {
      if (made >= PER_TICK) break;
      const r = await draftFor(user, item, { llm });
      if (r.drafted) made += 1;
    }
  }
  if (made) console.log(`[replyDrafter] drafted ${made} repl${made === 1 ? 'y' : 'ies'}`);
  return { made };
}

/** How the reply would be sent: which tool and arguments. */
function sendPlan(item, body) {
  const id = String(item.gmail_id || '');
  if (id.startsWith('webmail:')) return { tool: 'reply_business_email', input: { uid: parseInt(id.slice(8), 10), body } };
  return { tool: 'reply_to_email', input: { email_id: id, body } };
}

const fromName = (s) => String(s || '').replace(/\s*<.*>/, '').replace(/"/g, '').trim() || String(s || '');

/** Chat-prompt block: drafts waiting, so "send it" / "haan bhej do" just works. */
function promptBlock(user) {
  let rows = [];
  try { rows = emailItems.listPrepared(user.id, 5); } catch (_) { return ''; }
  if (!rows.length) return '';
  return `\n\n--- REPLIES YOU ALREADY DRAFTED AS THEM (waiting for their go) ---\n${rows.map((r) => `- email_item_id ${r.id} · ${fromName(r.sender)} — "${r.subject || ''}"${r.prepared_note ? ` · needs from them: ${r.prepared_note}` : ''}`).join('\n')}\n`
    + 'When they ask about pending emails or say "show me the replies", show the draft (get_prepared_reply). When they say send / bhej do / theek hai for one, call send_prepared_reply (with their edits as body if they changed anything). Fill any [gap] with what they tell you before sending — never send a draft that still has a [gap].';
}

module.exports = { draftFor, runDue, candidates, sendPlan, promptBlock, fetchBody, fromName, NO_REPLY };
