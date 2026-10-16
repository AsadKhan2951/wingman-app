'use strict';

/**
 * Bring the user's BUSINESS mailbox (IMAP/webmail) into the same email_items
 * store the Gmail scanner writes to, so the app's Email section shows business
 * mail alongside Gmail. Webmail rows are keyed with a `webmail:<uid>` id (no
 * Gmail id), which is also how the API tells the two sources apart for tagging.
 *
 * New emails are read + classified (so they land in the right bucket); already
 * stored ones are skipped. Throttled per user so opening the Email tab doesn't
 * hammer the mail host or the model.
 */

const usersRepo = require('../db/users');
const emailItems = require('../db/emailItems');
const webmail = require('./webmail');
const { analyzeEmail } = require('./emailAnalyzer');

const MAX_CLASSIFY = 12;                 // bound the per-sync model cost
const THROTTLE_MS = 3 * 60 * 1000;       // at most one heavy sync / 3 min / user
const IMPORTANT = new Set(['urgent', 'needs_reply']);

/** The synthetic email_items id for a webmail message. */
function idOf(uid) {
  return `webmail:${uid}`;
}

function touch(userId) {
  try {
    const u = usersRepo.getById(userId);
    if (!u) return;
    const p = u.preferences || {};
    p.webmailInboxAt = Date.now();
    usersRepo.update(userId, { preferences: p });
  } catch (_) { /* best-effort */ }
}

/**
 * Sync one user's business mailbox into email_items. Best-effort; never throws.
 * @returns {Promise<{stored:number, skipped?:string}>}
 */
async function syncUser(userId, { limit = 15, force = false } = {}) {
  const user = usersRepo.getById(userId);
  if (!user || !webmail.isConnected(user)) return { stored: 0, skipped: 'not_connected' };

  const prefs = user.preferences || {};
  const lastAt = Number(prefs.webmailInboxAt || 0);
  if (!force && Date.now() - lastAt < THROTTLE_MS) return { stored: 0, skipped: 'throttled' };

  let items;
  try { items = await webmail.listRecent(user, { limit }); }
  catch (e) { console.warn('[webmailInbox] list failed:', e.message); return { stored: 0, skipped: 'read_failed' }; }
  if (!items || !items.length) { touch(userId); return { stored: 0, skipped: 'empty' }; }

  const acctEmail = ((webmail.settingsFor(user) || {}).address) || null;
  const emailCtx = (user.preferences && user.preferences.emailContext) || {};
  const ctxText = String(emailCtx.instructions || '').trim();
  const notifyOn = !!ctxText && emailCtx.notify !== false;
  const priorityNotifies = [];
  const fresh = items.filter((m) => !emailItems.existsByGmailId(userId, idOf(m.uid)));

  // Fetch bodies for the newest new ones so they can be classified; older new
  // ones are stored with subject/sender only (bounded model cost).
  const toClassify = fresh.slice(-MAX_CLASSIFY);
  let bodies = new Map();
  if (toClassify.length) {
    try { bodies = await webmail.readBodies(user, toClassify.map((m) => m.uid)); }
    catch (e) { console.warn('[webmailInbox] body read failed:', e.message); }
  }

  let stored = 0;
  for (const m of fresh) {
    const full = bodies.get(Number(m.uid));
    let category = 'fyi';
    let summary = '';
    let actionNeeded = false;
    let detectedType = 'general';
    let extractedData = {};
    if (full && full.body) {
      try {
        const a = await analyzeEmail(
          { subject: full.subject || m.subject, sender: full.from || m.from, body: full.body },
          { context: ctxText },
        );
        category = a.category || 'fyi';
        summary = a.summary || '';
        actionNeeded = IMPORTANT.has(category);
        // Same types as Gmail (order, cancellation, bill, travel…) so business
        // mail is sorted into the right buckets too.
        detectedType = a.detectedType || 'general';
        extractedData = a.extractedData || {};
        if (notifyOn && a.notify && a.notifyMessage) priorityNotifies.push(a.notifyMessage.trim());
      } catch (_) { /* keep defaults */ }
    }
    try {
      emailItems.upsert(userId, {
        gmailId: idOf(m.uid),
        accountEmail: acctEmail,
        subject: m.subject || (full && full.subject) || '(no subject)',
        sender: (full && full.from) || m.from || m.fromAddress || 'unknown sender',
        category,
        summary,
        actionNeeded,
        detectedType,
        extractedData,
        receivedAt: m.date || null,
      });
      stored += 1;
    } catch (e) { console.warn('[webmailInbox] upsert failed:', e.message); }
  }

  // Personalised, context-driven pings the AI chose for business mail (capped).
  if (notifyOn && priorityNotifies.length) {
    const wa = require('../whatsapp/client');
    if (wa.ready()) {
      for (const message of priorityNotifies.slice(0, 4)) {
        try { await wa.sendMessage(user.phone, message); }
        catch (e) { console.warn('[webmailInbox] priority notify failed:', e.message); }
      }
    }
  }

  touch(userId);
  return { stored };
}

/** Sweep every connected business mailbox (called from the scheduler). */
async function syncAllUsers() {
  let rows = [];
  try { rows = usersRepo.listWebmailUsers(); } catch (_) { rows = []; }
  let total = 0;
  for (const row of rows) {
    try { const r = await syncUser(row.id, { force: true }); total += r.stored || 0; }
    catch (e) { console.warn('[webmailInbox] failed for', row.id, e.message); }
  }
  if (total) console.log('[webmailInbox] stored', total, 'new business email(s)');
  return total;
}

module.exports = { syncUser, syncAllUsers, idOf };
