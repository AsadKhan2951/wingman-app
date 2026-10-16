'use strict';

/**
 * Google connection health.
 *
 * When a user's Google refresh token stops working (invalid_grant — revoked or
 * expired; unauthorized_client — issued to a different OAuth client), every
 * Gmail / Calendar / Tasks call fails. Before this, those failures were only
 * logged, so Wingman silently answered from old data ("no new emails", wrong
 * times). Now:
 *   - markBroken() records it on the user (preferences.googleAuth),
 *   - tools return GOOGLE_RECONNECT_NEEDED so the assistant sends the link,
 *   - the user gets ONE WhatsApp heads-up per day with the reconnect link,
 *   - a successful reconnect (OAuth callback) clears it (markOk).
 */

const config = require('../config');
const usersRepo = require('../db/users');

const AUTH_ERR = /invalid_grant|unauthorized_client|invalid_client|no refresh token|token has been expired or revoked|invalid_rapt/i;

function isAuthError(err) {
  const msg = String((err && (err.message || (err.response && err.response.data && err.response.data.error))) || err || '');
  return AUTH_ERR.test(msg);
}

function state(user) {
  return (user && user.preferences && user.preferences.googleAuth) || null;
}

function isBroken(user) {
  const s = state(user);
  return !!(s && s.broken);
}

function connectLink(user) {
  return `${config.publicBaseUrl}/auth/google?${require('../utils/linkSig').connectQuery(user.phone)}`;
}

/** Record a dead Google token for this user; tell them once a day. */
async function markBroken(userOrId, { account = null, reason = '' } = {}) {
  try {
    const user = typeof userOrId === 'object' ? usersRepo.getById(userOrId.id) : usersRepo.getById(userOrId);
    if (!user) return;
    const prev = state(user) || {};
    const accounts = new Set(prev.accounts || []);
    if (account) accounts.add(account);
    const now = new Date();
    const notifiedAt = prev.notifiedAt ? Date.parse(prev.notifiedAt) : 0;
    const shouldTell = !notifiedAt || now - notifiedAt > 24 * 3600e3;
    usersRepo.updatePreferences(user.id, {
      googleAuth: {
        broken: true,
        since: prev.broken ? prev.since : now.toISOString(),
        reason: String(reason || prev.reason || '').slice(0, 120),
        accounts: [...accounts].slice(0, 5),
        notifiedAt: shouldTell ? now.toISOString() : prev.notifiedAt,
      },
    });
    if (shouldTell && user.phone && user.onboarding_complete) {
      const text = '⚠️ Your Google connection has expired, so I can\'t see your latest emails and calendar right now. '
        + `Tap to reconnect (takes 10 seconds): ${connectLink(user)}`;
      try { await require('../whatsapp/client').sendMessage(user.phone, text); } catch (_) { /* best effort */ }
    }
  } catch (e) {
    console.warn('[googleConnection] markBroken failed:', e.message);
  }
}

/** Google works again (fresh consent or a successful call). */
function markOk(userOrId) {
  try {
    const user = typeof userOrId === 'object' ? usersRepo.getById(userOrId.id) : usersRepo.getById(userOrId);
    if (!user || !isBroken(user)) return;
    usersRepo.updatePreferences(user.id, { googleAuth: { broken: false, fixedAt: new Date().toISOString() } });
  } catch (_) { /* best effort */ }
}

/** System-prompt line so the assistant never answers from stale data silently. */
function promptBlock(user) {
  if (!isBroken(user)) return '';
  return `\n\n--- GOOGLE CONNECTION EXPIRED ---\nThe user's Google connection stopped working (${state(user).reason || 'token expired'}). Gmail, Calendar and Google Tasks data may be OLD. If they ask about emails, meetings or Google tasks, say so in one line and send the Google connect link so they can reconnect — then answer with what you have, clearly marked as possibly out of date.`;
}

module.exports = { isAuthError, isBroken, markBroken, markOk, promptBlock, connectLink };
