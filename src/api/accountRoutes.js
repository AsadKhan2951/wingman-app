'use strict';

/**
 * Sign up / sign in with an ACCOUNT (email + password, Google, Apple).
 * Mounted at /api/auth next to the phone-OTP routes (authRoutes.js).
 *
 * Every successful sign-in answers in one of two shapes:
 *   { status: 'signed_in', token, expires_at, user, connect_sig, account }
 *       the account is already linked to a Wingman user (verified WhatsApp);
 *   { status: 'needs_phone', account_token, account }
 *       new account — the app now asks for the WhatsApp number and passes
 *       account_token to /verify-otp, which links the two.
 *
 *   GET  /providers                  which sign-in buttons to show
 *   POST /signup   {name,email,password}
 *   POST /login    {email,password}
 *   POST /forgot   {email}            code goes to the account's WhatsApp
 *   POST /reset    {email,code,password}
 *   GET  /google/start  → Google → GET /google/callback  ┐ both end at
 *   GET  /apple/start   → Apple  → POST /apple/callback  ┘ /#/auth-callback?code=
 *   POST /exchange {code}            app swaps that one-time code for the result
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const config = require('../config');
const accounts = require('../db/accounts');
const auth = require('../db/auth');
const usersRepo = require('../db/users');
const { signState, verifyState, connectSig } = require('../utils/linkSig');

const PENDING_TTL_MIN = 24 * 60;
const MIN_PASSWORD = 8;

// ── helpers ───────────────────────────────────────────────────────────
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return fwd || req.ip || '';
}

// Login/forgot attempts: 10 per 15 minutes per IP+email (in memory).
const attempts = new Map();
function limited(key, max = 10, windowMs = 15 * 60000) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) attempts.clear();
  return list.length > max;
}

/** The two possible answers after an account proves who it is. */
function accountResult(acc) {
  const user = acc.user_id ? usersRepo.getById(acc.user_id) : null;
  if (user) {
    accounts.touchLogin(acc.id);
    const session = auth.createSession(user.id, { ttlDays: config.auth.sessionTtlDays });
    return {
      status: 'signed_in',
      token: session.token,
      expires_at: session.expiresAt,
      user: usersRepo.toPublic(user),
      connect_sig: connectSig(user.phone),
      account: accounts.toPublic(acc),
    };
  }
  return {
    status: 'needs_phone',
    account_token: accounts.issueToken(acc.id, 'pending', PENDING_TTL_MIN),
    account: accounts.toPublic(acc),
  };
}

/**
 * Called by /verify-otp once the WhatsApp number is proven: link a pending
 * account to that user, and give the user the account's name if they had none.
 */
function linkPendingAccount(accountToken, user) {
  const acc = accounts.readToken(accountToken, 'pending', { consume: true });
  if (!acc || !user) return null;
  if (acc.user_id && acc.user_id !== user.id) return null;
  accounts.update(acc.id, { userId: user.id });
  accounts.touchLogin(acc.id);
  if (!String(user.name || '').trim() && acc.name) usersRepo.update(user.id, { name: acc.name });
  return accounts.getById(acc.id);
}

const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });

// ── providers ─────────────────────────────────────────────────────────
router.get('/providers', (req, res) => {
  res.json({ email: true, google: config.signin.google.enabled, apple: config.signin.apple.enabled, phone: true });
});

// ── email + password ──────────────────────────────────────────────────
router.post('/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!String(name || '').trim()) return fail(res, 400, 'Please tell me your name.');
  if (!accounts.validEmail(email)) return fail(res, 400, 'That email address doesn\'t look right.');
  if (String(password || '').length < MIN_PASSWORD) return fail(res, 400, `Use at least ${MIN_PASSWORD} characters for your password.`);
  if (limited(`signup:${clientIp(req)}`, 20, 60 * 60000)) return fail(res, 429, 'Too many attempts. Please try again later.');

  const existing = accounts.getByEmail(email);
  if (existing) {
    // Same person signing up twice with the same password → just sign them in.
    if (existing.password_hash && accounts.verifyPassword(password, existing.password_hash)) {
      return res.json(accountResult(existing));
    }
    // An unfinished sign-up (never linked to WhatsApp) older than a day can be
    // taken over — nothing is in it.
    const stale = !existing.user_id && Date.now() - Date.parse(String(existing.created_at).replace(' ', 'T') + 'Z') > 86400000;
    if (!stale) {
      return fail(res, 409, existing.password_hash
        ? 'There\'s already an account with this email. Sign in instead, or reset your password.'
        : 'This email is already used with Google or Apple sign-in. Use that button instead.', { reason: 'exists' });
    }
    const acc = accounts.update(existing.id, { name: String(name).trim(), password });
    return res.json(accountResult(acc));
  }

  const acc = accounts.create({ email, password, name });
  res.json(accountResult(acc));
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!accounts.validEmail(email) || !password) return fail(res, 400, 'Enter your email and password.');
  if (limited(`login:${clientIp(req)}:${accounts.normalizeEmail(email)}`)) {
    return fail(res, 429, 'Too many attempts. Please wait a few minutes and try again.');
  }
  const acc = accounts.getByEmail(email);
  if (!acc || !acc.password_hash || !accounts.verifyPassword(password, acc.password_hash)) {
    return fail(res, 401, acc && !acc.password_hash
      ? 'This email signs in with Google or Apple. Use that button instead.'
      : 'Wrong email or password.');
  }
  res.json(accountResult(acc));
});

// ── forgot password: the code goes to the WhatsApp number on the account ──
function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 4 ? `•••• ${d.slice(-4)}` : '';
}

router.post('/forgot', async (req, res) => {
  const email = accounts.normalizeEmail((req.body || {}).email);
  if (!accounts.validEmail(email)) return fail(res, 400, 'Enter the email you signed up with.');
  if (limited(`forgot:${clientIp(req)}`, 10, 60 * 60000)) return fail(res, 429, 'Too many attempts. Please try again later.');
  const acc = accounts.getByEmail(email);
  const user = acc && acc.user_id ? usersRepo.getById(acc.user_id) : null;
  if (!acc || !acc.password_hash) return fail(res, 404, 'No account with a password uses this email.');
  if (!user || !user.phone) {
    return fail(res, 409, 'This account was never linked to WhatsApp, so I can\'t send a reset code. Just create the account again.', { reason: 'unlinked' });
  }
  if (auth.recentRequestCount({ phone: user.phone }) >= 5) return fail(res, 429, 'Too many codes requested. Please wait a while.');
  const otp = auth.createOtp(user.phone, { purpose: 'reset', ttlSeconds: 600, ip: clientIp(req) });
  let delivered = false;
  try {
    const wa = require('../whatsapp/client');
    if (wa.ready()) delivered = !!(await wa.sendOtp(user.phone, otp.code));
  } catch (e) { console.warn('[account] reset code send failed:', e.message); }
  if (!delivered && !config.auth.exposeOtpInDev) {
    return fail(res, 503, 'I couldn\'t send the code to your WhatsApp right now. Please try again in a minute.');
  }
  res.json({ sent: true, phone_hint: maskPhone(user.phone), ...(config.auth.exposeOtpInDev && !delivered ? { dev_code: otp.code } : {}) });
});

router.post('/reset', (req, res) => {
  const { email, code, password } = req.body || {};
  if (String(password || '').length < MIN_PASSWORD) return fail(res, 400, `Use at least ${MIN_PASSWORD} characters for your password.`);
  const acc = accounts.getByEmail(email);
  const user = acc && acc.user_id ? usersRepo.getById(acc.user_id) : null;
  if (!acc || !user) return fail(res, 400, 'Start again from "Forgot password".');
  const r = auth.verifyOtp(user.phone, String(code || '').trim());
  if (!r.ok) {
    const map = { expired: 'That code has expired. Ask for a new one.', too_many_attempts: 'Too many attempts. Ask for a new code.', mismatch: 'That code is incorrect.' };
    return fail(res, 400, map[r.reason] || 'That code didn\'t work. Ask for a new one.');
  }
  const updated = accounts.update(acc.id, { password });
  res.json(accountResult(updated));
});

// ── Google / Apple (OAuth redirect flows) ─────────────────────────────
const base = () => String(config.publicBaseUrl || '').replace(/\/+$/, '');
const callbackUrl = (p) => `${base()}/api/auth/${p}/callback`;
// fromApp: started in the native app → hand back through its URL scheme.
const backToApp = (res, q, fromApp = false) => res.redirect(fromApp
  ? `${config.signin.appScheme}://auth-callback?${new URLSearchParams(q).toString()}`
  : `${base()}/#/auth-callback?${new URLSearchParams(q).toString()}`);

/** state = "<provider>" (web) or "<provider>:app" (native app). */
function readState(state, provider) {
  const v = verifyState(state);
  if (v === provider) return { ok: true, fromApp: false };
  if (v === `${provider}:app`) return { ok: true, fromApp: true };
  return { ok: false, fromApp: false };
}

function jwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return null; }
}

/**
 * Find or create the account for a Google/Apple identity. An existing email
 * account is only joined when ITS email was verified — otherwise someone could
 * pre-register a victim's address and receive their Google sign-ins.
 * (Either way, verifying the same WhatsApp number joins them to one user.)
 */
function providerAccount(provider, { sub, email, emailVerified, name }) {
  const subKey = provider === 'apple' ? 'appleSub' : 'googleSub';
  let acc = accounts.getByProvider(provider, sub);
  if (!acc && email && emailVerified) {
    const byEmail = accounts.getByEmail(email);
    if (byEmail && byEmail.email_verified) acc = accounts.update(byEmail.id, { [subKey]: sub });
  }
  if (!acc) {
    const emailFree = email && !accounts.getByEmail(email);
    acc = accounts.create({ email: emailFree ? email : null, name, [subKey]: sub, emailVerified: !!(emailFree && emailVerified) });
  }
  if (!acc.name && name) acc = accounts.update(acc.id, { name });
  return acc;
}

function finishProvider(res, acc, fromApp) {
  backToApp(res, { code: accounts.issueToken(acc.id, 'exchange', 5) }, fromApp);
}

router.get('/google/start', (req, res) => {
  const g = config.signin.google;
  const fromApp = req.query.app === '1';
  if (!g.enabled) return backToApp(res, { error: 'Google sign-in isn\'t available yet.' }, fromApp);
  const q = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: callbackUrl('google'),
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: signState(fromApp ? 'google:app' : 'google'),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
});

router.get('/google/callback', async (req, res) => {
  const g = config.signin.google;
  const st = readState(req.query.state, 'google');
  if (!st.ok) return backToApp(res, { error: 'Sign-in expired. Please try again.' });
  if (!req.query.code) return backToApp(res, { error: 'Google sign-in was cancelled.' }, st.fromApp);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code), client_id: g.clientId, client_secret: g.clientSecret,
        redirect_uri: callbackUrl('google'), grant_type: 'authorization_code',
      }),
    });
    const data = await r.json();
    // Straight from Google's token endpoint over TLS, so the id_token is trusted (OIDC §3.1.3.7).
    const p = r.ok ? jwtPayload(data.id_token) : null;
    if (!p || !p.sub) throw new Error(data.error_description || data.error || 'no id_token');
    finishProvider(res, providerAccount('google', { sub: p.sub, email: p.email, emailVerified: p.email_verified === true || p.email_verified === 'true', name: p.name }), st.fromApp);
  } catch (e) {
    console.warn('[account] google sign-in failed:', e.message);
    backToApp(res, { error: 'Google sign-in failed. Please try again.' }, st.fromApp);
  }
});

function appleClientSecret() {
  const a = config.signin.apple;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'ES256', kid: a.keyId })}.${b64({ iss: a.teamId, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: a.servicesId })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: a.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${sig.toString('base64url')}`;
}

router.get('/apple/start', (req, res) => {
  const a = config.signin.apple;
  const fromApp = req.query.app === '1';
  if (!a.enabled) return backToApp(res, { error: 'Apple sign-in isn\'t available yet.' }, fromApp);
  const q = new URLSearchParams({
    client_id: a.servicesId,
    redirect_uri: callbackUrl('apple'),
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state: signState(fromApp ? 'apple:app' : 'apple'),
  });
  res.redirect(`https://appleid.apple.com/auth/authorize?${q}`);
});

router.post('/apple/callback', express.urlencoded({ extended: false }), async (req, res) => {
  const a = config.signin.apple;
  const body = req.body || {};
  const st = readState(body.state, 'apple');
  if (!st.ok) return backToApp(res, { error: 'Sign-in expired. Please try again.' });
  if (!body.code) return backToApp(res, { error: 'Apple sign-in was cancelled.' }, st.fromApp);
  try {
    const r = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: a.servicesId, client_secret: appleClientSecret(), code: String(body.code),
        grant_type: 'authorization_code', redirect_uri: callbackUrl('apple'),
      }),
    });
    const data = await r.json();
    const p = r.ok ? jwtPayload(data.id_token) : null;
    if (!p || !p.sub) throw new Error(data.error || 'no id_token');
    // Apple sends the name only on the very first sign-in, in the form body.
    let name = null;
    try {
      const u = typeof body.user === 'string' ? JSON.parse(body.user) : body.user;
      name = [u && u.name && u.name.firstName, u && u.name && u.name.lastName].filter(Boolean).join(' ') || null;
    } catch (_) { /* no name */ }
    finishProvider(res, providerAccount('apple', { sub: p.sub, email: p.email, emailVerified: p.email_verified === true || p.email_verified === 'true', name }), st.fromApp);
  } catch (e) {
    console.warn('[account] apple sign-in failed:', e.message);
    backToApp(res, { error: 'Apple sign-in failed. Please try again.' }, st.fromApp);
  }
});

router.post('/exchange', (req, res) => {
  const acc = accounts.readToken(String((req.body || {}).code || ''), 'exchange', { consume: true });
  if (!acc) return fail(res, 400, 'That sign-in link has expired. Please try again.');
  res.json(accountResult(acc));
});

module.exports = router;
module.exports.linkPendingAccount = linkPendingAccount;
module.exports.accountResult = accountResult;
module.exports.providerAccount = providerAccount;
module.exports.appleClientSecret = appleClientSecret;
