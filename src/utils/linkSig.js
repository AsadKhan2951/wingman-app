'use strict';

/**
 * Signed connect links and OAuth state.
 *
 * A connect link (/auth/google?phone=…) used to work for ANY phone number, so
 * anyone could start the flow for someone else's number and attach their own
 * Google / Shopify / wearable account to that person's Wingman. Now:
 *   - the link carries sig = HMAC(phone), issued only to that user (in their
 *     WhatsApp chat, or to the app after sign-in);
 *   - the OAuth `state` that comes back to the callback is signed and
 *     time-limited, so a callback can't be replayed with another phone in it.
 */

const crypto = require('crypto');
const config = require('../config');
const { phoneKey } = require('./phone');

let warned = false;
function secret() {
  const s = config.security.linkSecret;
  if (s) return s;
  if (!warned) {
    warned = true;
    console.warn('[security] SECRET_KEY is not set — connect links are signed with a derived key. Set SECRET_KEY in .env.');
  }
  return crypto.createHash('sha256').update(`wingman-link|${config.security.linkSecretFallback}`).digest('hex');
}

function hmac(text) {
  return crypto.createHmac('sha256', secret()).update(String(text)).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}


/** Signature that lets this phone's owner start a connect flow. */
function connectSig(phone) {
  return hmac(`connect:${phoneKey(phone)}`).slice(0, 32);
}

function verifyConnectSig(phone, sig) {
  if (!phone || !sig) return false;
  return safeEqual(connectSig(phone), sig);
}

/** "phone=…&sig=…" for building connect URLs. */
function connectQuery(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `phone=${encodeURIComponent(digits)}&sig=${encodeURIComponent(connectSig(digits))}`;
}

const STATE_TTL_MS = 60 * 60 * 1000;

/** Signed OAuth state carrying `value` (e.g. "923001234567|health"). */
function signState(value) {
  const body = `${value}~${Date.now().toString(36)}`;
  return `${body}.${hmac(`state:${body}`).slice(0, 32)}`;
}

/** → the original value, or null when the state is forged / expired. */
function verifyState(state) {
  const s = String(state || '');
  const dot = s.lastIndexOf('.');
  if (dot < 0) return null;
  const body = s.slice(0, dot);
  if (!safeEqual(hmac(`state:${body}`).slice(0, 32), s.slice(dot + 1))) return null;
  const tilde = body.lastIndexOf('~');
  if (tilde < 0) return null;
  const at = parseInt(body.slice(tilde + 1), 36);
  if (!Number.isFinite(at) || Date.now() - at > STATE_TTL_MS) return null;
  return body.slice(0, tilde);
}

/**
 * Is this request allowed to start a connect flow for `phone`? True with a
 * valid sig, or when signing is switched off.
 */
function canStartConnect(req, phone) {
  if (!config.security.signedConnectLinks) return true;
  const sig = (req.query && req.query.sig) || '';
  return verifyConnectSig(phone, sig);
}

module.exports = {
  connectSig, verifyConnectSig, connectQuery, signState, verifyState, canStartConnect, safeEqual,
};
