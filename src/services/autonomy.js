'use strict';

/**
 * Earned autonomy — how Wingman graduates from "ask every time" to "I just do
 * it for you", one kind of action at a time, the way a new chief of staff earns
 * trust.
 *
 * Every write Wingman proposes is already recorded in integration_actions with
 * its outcome (done = approved, cancelled = declined). From that history:
 *   - decisionSummary() feeds the Operating Manual ("HOW THEY DECIDE").
 *   - afterApproval(): once the user has approved the same KIND of action
 *     (e.g. "replies to Ali", "Slack messages to #sales") several times in a
 *     row without declining, Wingman offers once: "want me to just do these
 *     from now on?"
 *   - grant(): only after that offer and the user's yes, a scoped standing rule
 *     is saved; isGranted() lets the gate run that kind without asking —
 *     in live chat only, never from an automated run.
 * Money, deletes, sharing, forwarding and disconnects can never be granted.
 */

const { db } = require('../db');
const usersRepo = require('../db/users');
const rules = require('../db/userRules');

const STREAK_TO_OFFER = 4;
const OFFER_VALID_HOURS = 48;
const REOFFER_AFTER_DAYS = 14;
const HISTORY_DAYS = 60;

// Built-ins that may be earned, and how each is scoped.
const EARNABLE_BUILTIN = new Set(['send_email', 'reply_to_email', 'send_business_email', 'reply_business_email']);
// Never: money, deletes, sharing data with new people, rules/disconnects.
const NEVER = new Set(['book_ride', 'cancel_ride', 'delete_event', 'delete_drive_file', 'share_drive_file', 'forward_email', '__DISCONNECT__', '__RULE__']);

const lower = (s) => String(s || '').trim().toLowerCase();
const emailOf = (s) => { const m = String(s || '').match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/); return m ? m[0].toLowerCase() : ''; };

/** Who a reply goes to, without calling Gmail/IMAP (from the synced inbox). */
function replyRecipient(userId, slug, args) {
  try {
    if (slug === 'reply_to_email') {
      const r = db.prepare('SELECT sender FROM email_items WHERE user_id = ? AND gmail_id = ? LIMIT 1').get(userId, String(args.email_id || args.id || ''));
      return r ? emailOf(r.sender) : '';
    }
    if (slug === 'reply_business_email') {
      const r = db.prepare('SELECT sender FROM email_items WHERE user_id = ? AND gmail_id = ? LIMIT 1').get(userId, `webmail:${args.uid}`);
      return r ? emailOf(r.sender) : '';
    }
  } catch (_) { /* unknown */ }
  return '';
}

/**
 * The KIND an action belongs to, for trust purposes, or null if it can never be
 * done without asking. { key, slug, scope, label }
 */
function kindOf(userId, toolkit, slug, args = {}, { result } = {}) {
  if (!slug || NEVER.has(slug)) return null;
  if (toolkit === 'builtin') {
    if (!EARNABLE_BUILTIN.has(slug)) return null;
    let to = slug.startsWith('send_') ? emailOf(args.to) : replyRecipient(userId, slug, args);
    if (!to && result) { try { to = emailOf((typeof result === 'string' ? JSON.parse(result) : result).to); } catch (_) { /* none */ } }
    if (!to) return null;
    const what = slug.startsWith('reply') ? 'Replies' : 'Emails';
    const box = slug.includes('business') ? ' from the business address' : '';
    return { key: `${slug}|${to}`, slug, scope: to, label: `${what} to ${to}${box}` };
  }
  // A connected app (Composio): the existing per-tool rule; never risky ones.
  try {
    const ie = require('../engine/integrationExecutor');
    if (ie.canEverAutoApprove && !ie.canEverAutoApprove(toolkit, slug, require('./composio').toolMeta(slug))) return null;
  } catch (_) { return null; }
  return { key: slug, slug, scope: null, label: slug.replace(/_/g, ' ').toLowerCase() };
}

function history(userId, days = HISTORY_DAYS) {
  return db.prepare(`
    SELECT toolkit, tool_slug, arguments, status, result, created_at FROM integration_actions
    WHERE user_id = ? AND status IN ('done', 'cancelled', 'failed') AND created_at >= datetime('now', ?)
    ORDER BY created_at ASC, rowid ASC
  `).all(userId, `-${days} days`).map((r) => {
    let args = {};
    try { args = JSON.parse(r.arguments || '{}'); } catch (_) { /* none */ }
    return { ...r, args };
  });
}

/** Approvals in a row (newest backwards) for this kind; a decline resets it. */
function streakFor(userId, key) {
  const rows = history(userId).filter((r) => {
    const k = kindOf(userId, r.toolkit, r.tool_slug, r.args, { result: r.result });
    return k && k.key === key;
  });
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].status === 'done') streak += 1;
    else if (rows[i].status === 'cancelled') break;
  }
  return streak;
}

/** Is this exact kind already allowed without asking? */
function isGranted(userId, toolkit, slug, args = {}) {
  const k = kindOf(userId, toolkit, slug, args);
  if (!k) return false;
  const row = db.prepare("SELECT 1 FROM user_rules WHERE user_id = ? AND kind = 'auto_approve' AND tool_slug = ? AND COALESCE(scope, '') = ? LIMIT 1")
    .get(userId, k.slug, k.scope || '');
  return !!row;
}

function offersOf(user) {
  return (user && user.preferences && user.preferences.autonomyOffers) || {};
}

/**
 * Called right after an approved action ran. Returns an offer for the model to
 * put to the user ("want me to just do these from now on?"), or null.
 */
function afterApproval(user, row) {
  try {
    const k = kindOf(user.id, row.toolkit, row.tool_slug, row.arguments || {}, { result: row.result });
    if (!k || isGranted(user.id, row.toolkit, row.tool_slug, row.arguments || {})) return null;
    if (streakFor(user.id, k.key) < STREAK_TO_OFFER) return null;
    const fresh = usersRepo.getById(user.id) || user;
    const offers = offersOf(fresh);
    const prev = offers[k.key];
    if (prev && Date.now() - Date.parse(prev.at) < REOFFER_AFTER_DAYS * 86400e3) return null;
    offers[k.key] = { at: new Date().toISOString(), toolkit: row.toolkit, slug: k.slug, scope: k.scope, label: k.label };
    usersRepo.updatePreferences(user.id, { autonomyOffers: offers });
    return {
      offer_key: k.key,
      what: k.label,
      instruction: `They have approved "${k.label}" ${STREAK_TO_OFFER}+ times in a row. After saying it's done, ask ONCE, in one short line in their language, whether you should just do this kind of thing without asking from now on (they can take it back any time). If they say yes, call grant_autonomy with this offer_key. If no, drop it.`,
    };
  } catch (err) {
    console.warn('[autonomy] afterApproval failed:', err.message);
    return null;
  }
}

/** The user said yes to an offer → save the scoped standing rule. */
function grant(user, offerKey) {
  const fresh = usersRepo.getById(user.id) || user;
  const offers = offersOf(fresh);
  const o = offers[offerKey];
  if (!o || Date.now() - Date.parse(o.at) > OFFER_VALID_HOURS * 3600e3) {
    return { error: 'NO_OPEN_OFFER', detail: 'You can only grant something you offered in the last two days, after the user agreed.' };
  }
  const r = rules.add(user.id, { kind: 'auto_approve', text: o.label, toolkit: o.toolkit, toolSlug: o.slug, scope: o.scope });
  if (r.reason === 'too_many') return { error: 'TOO_MANY_RULES' };
  delete offers[offerKey];
  usersRepo.updatePreferences(user.id, { autonomyOffers: offers });
  return { granted: true, what: o.label, note: 'Confirm in one line, and that they can say "ask me again for these" any time.' };
}

/** "HOW THEY DECIDE" raw material for the Operating Manual. */
function decisionSummary(userId) {
  const rows = history(userId, 90);
  if (!rows.length) return '';
  const by = {};
  for (const r of rows) {
    const k = kindOf(userId, r.toolkit, r.tool_slug, r.args, { result: r.result });
    const label = k ? k.label : r.tool_slug.replace(/_/g, ' ').toLowerCase();
    const b = (by[label] = by[label] || { done: 0, cancelled: 0 });
    if (r.status === 'done') b.done += 1;
    if (r.status === 'cancelled') b.cancelled += 1;
  }
  const lines = Object.entries(by).sort((a, b) => (b[1].done + b[1].cancelled) - (a[1].done + a[1].cancelled)).slice(0, 12)
    .map(([label, b]) => `- ${label}: approved ${b.done}, declined ${b.cancelled}`);
  const granted = db.prepare("SELECT text FROM user_rules WHERE user_id = ? AND kind = 'auto_approve'").all(userId).map((r) => r.text);
  return `HOW THEY DECIDED ON THINGS YOU PROPOSED (last 90 days):\n${lines.join('\n')}${granted.length ? `\nAlready allowed without asking: ${granted.join('; ')}` : ''}`;
}

module.exports = { kindOf, streakFor, isGranted, afterApproval, grant, decisionSummary, STREAK_TO_OFFER, NEVER };
