'use strict';

/**
 * Google connection health — PER ACCOUNT.
 *
 * When a Google refresh token stops working (invalid_grant — revoked/expired;
 * unauthorized_client — issued to an old OAuth client), calls for THAT account
 * fail. What used to go wrong:
 *   - one dead account (a second inbox, or an old pre-multi-account connection
 *     with no email on it) made the user hear "Your Google connection has
 *     expired" even though their main account worked fine;
 *   - reconnecting added a NEW row and never replaced the dead one, so the
 *     warning came back a few hours later;
 *   - markOk() wiped the "last told" time, so the next failure re-sent at once.
 * Now:
 *   - state is kept per account (preferences.googleAuth.accounts[key]);
 *   - an account is only "broken" after 2 auth failures ≥10 min apart (one
 *     odd failure never pings anyone);
 *   - the message names the exact account and the link pre-selects it;
 *   - per account: at most one notice every 3 days, max 3 notices, and never
 *     within 24h of a reconnect;
 *   - success on an account clears only that account;
 *   - isBroken(user) = the PRIMARY account is dead (main data is stale).
 */

const config = require('../config');
const usersRepo = require('../db/users');

const AUTH_ERR = /invalid_grant|unauthorized_client|invalid_client|no refresh token|token has been expired or revoked|invalid_rapt/i;
const CONFIRM_GAP_MS = 10 * 60e3;
const NOTICE_EVERY_MS = 3 * 24 * 3600e3;
const MAX_NOTICES = 3;
const QUIET_AFTER_FIX_MS = 24 * 3600e3;
let clock = () => Date.now(); // test hook

function isAuthError(err) {
  const msg = String((err && (err.message || (err.response && err.response.data && err.response.data.error))) || err || '');
  return AUTH_ERR.test(msg);
}

function accountsRepo() { return require('../db/googleAccounts'); }

function freshUser(userOrId) {
  const id = userOrId && typeof userOrId === 'object' ? userOrId.id : userOrId;
  return id ? usersRepo.getById(id) : null;
}

function keyOfRow(row) {
  return row ? (row.email ? String(row.email).toLowerCase() : `id:${row.id}`) : null;
}

/** account may be a google_accounts row, an email, or nothing (= primary). */
function resolve(user, account) {
  if (account && typeof account === 'object') return { key: keyOfRow(account), row: account };
  if (account) {
    const row = accountsRepo().findByEmail(user.id, account);
    return { key: String(account).toLowerCase(), row };
  }
  let row = null;
  try { row = accountsRepo().getPrimary(user.id); } catch (_) { row = null; }
  return { key: row ? keyOfRow(row) : 'legacy', row };
}

function state(user) {
  const s = (user && user.preferences && user.preferences.googleAuth) || {};
  // Old shape (single flag + list) → start clean; real failures re-confirm.
  const accounts = (s.accounts && !Array.isArray(s.accounts) && typeof s.accounts === 'object') ? s.accounts : {};
  return { accounts, notices: s.notices || {}, fixedAt: s.fixedAt || null };
}

function save(user, st) {
  const brokenKeys = Object.keys(st.accounts).filter((k) => st.accounts[k].confirmed);
  usersRepo.updatePreferences(user.id, {
    googleAuth: {
      broken: brokenKeys.length > 0,
      accounts: st.accounts,
      notices: st.notices,
      fixedAt: st.fixedAt,
    },
  });
}

function primaryKey(user) {
  try { const p = accountsRepo().getPrimary(user.id); return p ? keyOfRow(p) : 'legacy'; } catch (_) { return 'legacy'; }
}

/** The PRIMARY account is dead → main Gmail/Calendar data is stale. */
function isBroken(user) {
  const u = user && user.preferences ? user : freshUser(user);
  if (!u) return false;
  const a = state(u).accounts[primaryKey(u)];
  return !!(a && a.confirmed);
}

function brokenAccounts(user) {
  const u = user && user.preferences ? user : freshUser(user);
  if (!u) return [];
  const st = state(u);
  return Object.keys(st.accounts).filter((k) => st.accounts[k].confirmed);
}

function connectLink(user, email = null) {
  const hint = email && /@/.test(email) ? `&hint=${encodeURIComponent(email)}` : '';
  return `${config.publicBaseUrl}/auth/google?${require('../utils/linkSig').connectQuery(user.phone)}${hint}`;
}

function noticeText(user, key, isPrimary) {
  const email = /@/.test(key) ? key : null;
  const link = connectLink(user, email);
  if (email && isPrimary) {
    return `⚠️ Google access for *${email}* stopped working, so I can't see its latest emails and calendar. Tap to reconnect that account (10 seconds): ${link}`;
  }
  if (email) {
    return `⚠️ Your other Google account *${email}* stopped syncing (your main account is fine). If you still want me to read it, reconnect it here: ${link}`;
  }
  return `⚠️ An older Google connection on your Wingman stopped working. Tap and pick your main Google account to refresh it (10 seconds): ${link}`;
}

/** Record an auth failure for one account; tell the user only when it's real. */
async function markBroken(userOrId, { account = null, reason = '' } = {}) {
  try {
    const user = freshUser(userOrId);
    if (!user) return;
    const { key } = resolve(user, account);
    const st = state(user);
    const now = clock();
    const a = st.accounts[key] || { firstAt: new Date(now).toISOString(), fails: 0 };
    a.fails = (a.fails || 0) + 1;
    a.lastAt = new Date(now).toISOString();
    a.reason = String(reason || a.reason || '').slice(0, 120);
    // Confirmed only after a second failure at least 10 minutes after the first.
    if (!a.confirmed && a.fails >= 2 && now - Date.parse(a.firstAt) >= CONFIRM_GAP_MS) a.confirmed = true;
    st.accounts[key] = a;

    // Self-heal: the PRIMARY is dead but another linked account works → make
    // that one primary, so features keep running and nobody is pinged about
    // a connection they no longer use.
    if (a.confirmed && key === primaryKey(user)) {
      try {
        const others = accountsRepo().listForUser(user.id).filter((r) => keyOfRow(r) !== key && !(st.accounts[keyOfRow(r)] || {}).confirmed);
        for (const r of others) {
          if ((await require('../auth/googleAuth').tokenWorks(r)).ok) {
            accountsRepo().setPrimary(user.id, r.id);
            console.log(`[googleConnection] user ${user.id}: primary ${key} dead → ${keyOfRow(r)} is now primary`);
            break;
          }
        }
      } catch (_) { /* best effort */ }
    }
    // A dead connection with no email (pre multi-account) while a working
    // account exists → nothing for the user to do; don't ping.
    const silent = !/@/.test(key) && key !== primaryKey(user);

    let tell = false;
    if (a.confirmed && !silent) {
      const n = st.notices[key] || { count: 0, at: null };
      const sinceFix = st.fixedAt ? now - Date.parse(st.fixedAt) : Infinity;
      tell = n.count < MAX_NOTICES
        && (!n.at || now - Date.parse(n.at) >= NOTICE_EVERY_MS)
        && sinceFix >= QUIET_AFTER_FIX_MS;
      if (tell) st.notices[key] = { count: n.count + 1, at: new Date(now).toISOString() };
    }
    save(user, st);

    if (tell && user.phone && user.onboarding_complete) {
      const text = noticeText(user, key, key === primaryKey(user));
      try { await require('../whatsapp/client').sendMessage(user.phone, text); } catch (_) { /* best effort */ }
    }
  } catch (e) {
    console.warn('[googleConnection] markBroken failed:', e.message);
  }
}

/**
 * This account works again (successful call or fresh consent). Without an
 * account → the primary. { all: true } → everything. { reconnected: true } →
 * the user just went through consent: reset that account's notices and stay
 * quiet for 24h.
 */
function markOk(userOrId, { account = null, all = false, reconnected = false } = {}) {
  try {
    const user = freshUser(userOrId);
    if (!user) return;
    const st = state(user);
    const keys = all ? Object.keys(st.accounts) : [resolve(user, account).key];
    let changed = false;
    for (const k of keys) {
      if (st.accounts[k]) { delete st.accounts[k]; changed = true; }
      if (reconnected && st.notices[k]) { delete st.notices[k]; changed = true; }
    }
    if (reconnected) { st.fixedAt = new Date(clock()).toISOString(); changed = true; }
    if (changed) save(user, st);
  } catch (_) { /* best effort */ }
}

/** Forget state for accounts that no longer exist (unlinked / adopted). */
function prune(userOrId) {
  try {
    const user = freshUser(userOrId);
    if (!user) return;
    const live = new Set(accountsRepo().listForUser(user.id).map(keyOfRow));
    const st = state(user);
    let changed = false;
    for (const k of Object.keys(st.accounts)) {
      if (k !== 'legacy' && !live.has(k)) { delete st.accounts[k]; changed = true; }
    }
    if (changed) save(user, st);
  } catch (_) { /* best effort */ }
}

/** System-prompt line so the assistant never answers from stale data silently. */
function promptBlock(user) {
  const keys = brokenAccounts(user);
  if (!keys.length) return '';
  const list = keys.map((k) => (/@/.test(k) ? k : 'an older connection')).join(', ');
  return isBroken(user)
    ? `\n\n--- GOOGLE CONNECTION EXPIRED ---\nThe user's MAIN Google account stopped working (${list}). Gmail, Calendar and Google Tasks data may be OLD. If they ask about emails, meetings or Google tasks, say so in one line and send the Google connect link so they can reconnect — then answer with what you have, clearly marked as possibly out of date.`
    : `\n\n--- GOOGLE: ONE EXTRA ACCOUNT NOT SYNCING ---\nThe main Google account works. Only ${list} is not syncing. Don't warn about it unless they ask about that account.`;
}

module.exports = {
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  isAuthError, isBroken, brokenAccounts, markBroken, markOk, prune, promptBlock, connectLink, keyOfRow,
};
