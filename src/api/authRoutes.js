'use strict';

/**
 * Phone + OTP authentication for the Wingman web app.
 *
 * Flow:
 *   1. POST /api/auth/request-otp  { phone }
 *        → creates a 6-digit OTP, tries to deliver it via Wingman's WhatsApp
 *          number. In dev (config.auth.exposeOtpInDev) the code is also
 *          returned in the response so the app can be tested without a live
 *          WhatsApp pairing.
 *   2. POST /api/auth/verify-otp   { phone, code }
 *        → verifies the code, finds-or-creates the user, mints a session
 *          token, returns { token, user }.
 *   3. POST /api/auth/logout       (Authorization: Bearer <token>)
 *        → destroys the session.
 *   4. GET  /api/auth/me           (Authorization: Bearer <token>)
 *        → returns the current user (public projection).
 *
 * Wingman runs on its OWN WhatsApp number; OTP delivery uses that number.
 */

const express = require('express');
const router = express.Router();

const config = require('../config');
const auth = require('../db/auth');
const usersRepo = require('../db/users');
const wa = require('../whatsapp/client');
const { readToken } = require('./middleware/auth');

/** Normalize a user-entered phone into digits only (E.164 without '+'). */
function normalizePhone(input) {
  if (!input) return '';
  return String(input).replace(/[^0-9]/g, '');
}

// Abuse limits for code requests (each one may cost a WhatsApp template).
const MAX_PER_PHONE_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 20;
const OTP_TTL_SECONDS = Math.max(config.auth.otpTtlSeconds || 0, 600);

function clientIp(req) {
  // The reverse proxy APPENDS the real client address, so take the last hop —
  // the first one is whatever the client claimed.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || '';
}

/** wa.me link that opens a chat with Wingman, pre-filled with the sign-in reference. */
function verifyLink(ref) {
  const number = String(config.wingmanNumber || '').replace(/[^0-9]/g, '');
  const text = `Sign me in to Wingman: WM-${ref}`;
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null;
}

// ── POST /api/auth/request-otp ────────────────────────────────────────
// Response:
//   { sent, delivered, channel, ref, poll_secret, wa_link, expires_in }
//   delivered=true  → the code went out on WhatsApp (text or template).
//   delivered=false → it can't be pushed to this number (new number, outside
//                     the 24h window, no AUTHENTICATION template). The app shows
//                     "Get my code on WhatsApp": wa_link opens a chat with
//                     Wingman pre-filled "WM-<ref>"; sending it proves the
//                     number, Wingman replies with the code, and polling
//                     /otp-status with poll_secret signs the app in.
router.post('/request-otp', async (req, res) => {
  const phone = normalizePhone((req.body || {}).phone);
  if (!phone || phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }
  const ip = clientIp(req);
  if (auth.recentRequestCount({ phone }) >= MAX_PER_PHONE_PER_HOUR
      || (ip && auth.recentRequestCount({ ip }) >= MAX_PER_IP_PER_HOUR)) {
    return res.status(429).json({ error: 'Too many code requests. Please wait a while and try again.' });
  }

  try {
    const otp = auth.createOtp(phone, { purpose: 'login', ttlSeconds: OTP_TTL_SECONDS, ip });

    let channel = false;
    try {
      if (wa.ready()) channel = await wa.sendOtp(phone, otp.code);
    } catch (waErr) {
      console.warn('[auth] OTP WhatsApp delivery failed:', waErr.message);
    }
    const delivered = !!channel;

    // The code must arrive on the user's WhatsApp by itself. If it couldn't be
    // sent (template missing/rejected, WhatsApp down), say so — never leave
    // the user waiting for a code that isn't coming.
    if (!delivered && !config.auth.exposeOtpInDev) {
      return res.status(503).json({
        error: "We couldn't send the code to your WhatsApp right now. Please try again in a minute.",
      });
    }

    const payload = {
      sent: true,
      delivered,
      channel: channel || 'reply',
      ref: otp.ref,
      poll_secret: otp.pollSecret,
      wa_link: verifyLink(otp.ref),
      expires_in: OTP_TTL_SECONDS,
    };

    // Only surface the code on-screen when dev exposure is explicitly enabled
    // AND WhatsApp delivery did not succeed — so a real, delivered OTP is never
    // leaked into the UI in front of a client. EXPOSE_OTP_IN_DEV=0 in production.
    if (config.auth.exposeOtpInDev && !delivered) {
      console.log(`[auth] DEV OTP for ${phone}: ${otp.code}`);
      payload.dev_code = otp.code;
    }

    res.json(payload);
  } catch (err) {
    console.error('[auth] request-otp error:', err);
    res.status(500).json({ error: 'Could not create verification code.' });
  }
});

/**
 * Find-or-create the user for a verified phone and mint a session. With an
 * account_token (signed up with email/Google/Apple, now verifying WhatsApp)
 * the account is linked to this user.
 */
function signInPhone(phone, { accountToken = null } = {}) {
  let user = usersRepo.getByPhone(phone);
  if (!user) user = usersRepo.create({ phone });
  let account = null;
  if (accountToken) {
    account = require('./accountRoutes').linkPendingAccount(accountToken, user);
    user = usersRepo.getById(user.id) || user;
  }
  const session = auth.createSession(user.id, { ttlDays: config.auth.sessionTtlDays });
  return {
    status: 'signed_in',
    token: session.token,
    expires_at: session.expiresAt,
    user: usersRepo.toPublic(user),
    connect_sig: require('../utils/linkSig').connectSig(user.phone),
    ...(account ? { account: require('../db/accounts').toPublic(account) } : {}),
  };
}

// ── POST /api/auth/otp-status  { phone, poll_secret } ─────────────────
// Polled by the app after it opened the WhatsApp link. Returns
// { status: 'pending' } until the user's "WM-<ref>" message arrives, then
// { status: 'confirmed', token, user } exactly once.
router.post('/otp-status', (req, res) => {
  const body = req.body || {};
  const phone = normalizePhone(body.phone);
  const secret = String(body.poll_secret || '');
  if (!phone || !secret) return res.status(400).json({ error: 'phone and poll_secret are required.' });
  const status = auth.takeConfirmed(phone, secret);
  if (status !== 'confirmed') return res.json({ status });
  res.json({ status, ...signInPhone(phone) });
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────
router.post('/verify-otp', (req, res) => {
  const body = req.body || {};
  const phone = normalizePhone(body.phone);
  const code = (body.code || '').toString().trim();

  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and code are required.' });
  }

  const result = auth.verifyOtp(phone, code);
  if (!result.ok) {
    const map = {
      no_code: 'No verification code found. Please request a new one.',
      expired: 'That code has expired. Please request a new one.',
      too_many_attempts: 'Too many attempts. Please request a new code.',
      mismatch: 'That code is incorrect. Please try again.',
    };
    return res.status(400).json({ error: map[result.reason] || 'Verification failed.', reason: result.reason });
  }

  res.json(signInPhone(phone, { accountToken: body.account_token ? String(body.account_token) : null }));
});

// ── POST /api/auth/logout ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const token = readToken(req);
  try {
    auth.destroySession(token);
  } catch (_) { /* ignore */ }
  res.json({ ok: true });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = readToken(req);
  const userId = auth.resolveSession(token);
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
  const user = usersRepo.getById(userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  let logins = [];
  try { logins = require('../db/accounts').listForUser(user.id).map(require('../db/accounts').toPublic); } catch (_) { /* none */ }
  res.json({ user: usersRepo.toPublic(user), accounts: logins });
});

// Email/password, Google and Apple sign-in live in accountRoutes.
router.use('/', require('./accountRoutes'));

module.exports = router;
