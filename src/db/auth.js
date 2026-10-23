'use strict';

const crypto = require('crypto');
const { db, uuid } = require('./index');
const { phoneKey } = require('../utils/phone');

// ── OTP codes ─────────────────────────────────────────────────────────

// Unambiguous alphabet for the reply-to-verify reference (no 0/O, 1/I/L).
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomRef(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return out;
}

/** Create a new OTP for a phone; invalidates prior unconsumed codes. */
function createOtp(phone, { purpose = 'login', ttlSeconds = 300, ip = null } = {}) {
  // Invalidate previous unconsumed codes for this phone.
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE phone = ? AND consumed = 0').run(phone);
  const id = uuid();
  // crypto, not Math.random: this code is a login credential.
  const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
  const ref = randomRef();
  const pollSecret = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare(`
    INSERT INTO otp_codes (id, phone, code, purpose, expires_at, ref, poll_secret, ip)
    VALUES (@id, @phone, @code, @purpose, @expiresAt, @ref, @pollSecret, @ip)
  `).run({ id, phone, code, purpose, expiresAt, ref, pollSecret, ip });
  return { id, phone, code, purpose, expiresAt, ref, pollSecret };
}

/** How many codes were requested for this phone / from this IP recently. */
function recentRequestCount({ phone = null, ip = null, minutes = 60 } = {}) {
  const since = new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
  if (phone) {
    return db.prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at > ?').get(phone, since).n;
  }
  if (ip) {
    return db.prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE ip = ? AND created_at > ?').get(ip, since).n;
  }
  return 0;
}


/**
 * The user messaged Wingman "WM-<ref>" from WhatsApp number `fromPhone`.
 * Sending from the number is the proof of ownership, and it confirms ONLY the
 * login request that ref names — never "the newest one for that number", which
 * let someone who started a request for your number get signed in by any WM-
 * message you sent (or by racing your own). After a "Resend" the old ref is
 * dead; the user sends the new message the app opened.
 * Returns { ok, code } or { ok:false, reason }.
 */
function confirmByRef(fromPhone, ref) {
  const r = String(ref || '').toUpperCase();
  const byRef = r ? db.prepare(`
    SELECT * FROM otp_codes WHERE ref = ? AND purpose = 'login' ORDER BY created_at DESC LIMIT 1
  `).get(r) : null;
  if (!byRef) return { ok: false, reason: 'unknown' };
  if (phoneKey(byRef.phone) !== phoneKey(fromPhone)) return { ok: false, reason: 'other_number', phone: byRef.phone };
  if (byRef.consumed || new Date(byRef.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  db.prepare('UPDATE otp_codes SET confirmed = 1 WHERE id = ? AND consumed = 0').run(byRef.id);
  return { ok: true, code: byRef.code, phone: byRef.phone };
}

/**
 * The app polls with the secret it got from request-otp. Once the user has
 * confirmed from WhatsApp, this consumes the code exactly once.
 * Returns 'confirmed' | 'pending' | 'expired' | 'unknown'.
 */
function takeConfirmed(phone, pollSecret) {
  if (!phone || !pollSecret) return 'unknown';
  const row = db.prepare(`
    SELECT * FROM otp_codes WHERE phone = ? AND poll_secret = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(phone, String(pollSecret));
  if (!row) return 'unknown';
  if (row.consumed) return 'unknown';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  if (!row.confirmed) return 'pending';
  const r = db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ? AND consumed = 0').run(row.id);
  return r.changes ? 'confirmed' : 'unknown';
}

/**
 * Verify an OTP for a phone. Returns { ok, reason }.
 * Consumes the code on success.
 */
function verifyOtp(phone, code) {
  const row = db.prepare(`
    SELECT * FROM otp_codes
    WHERE phone = ? AND consumed = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(phone);
  if (!row) return { ok: false, reason: 'no_code' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= 5) {
    db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (String(row.code) !== String(code).trim()) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, reason: 'mismatch' };
  }
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return { ok: true, purpose: row.purpose };
}

// ── Sessions ──────────────────────────────────────────────────────────

/** Create a session token for a user. */
function createSession(userId, { ttlDays = 30 } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (@token, @userId, @expiresAt)
  `).run({ token, userId, expiresAt });
  return { token, expiresAt };
}

/** Resolve a session token to a user id (or null). Touches last_seen. */
function resolveSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?").run(token);
  return row.user_id;
}

/** Destroy a session (logout). */
function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  createOtp, verifyOtp, recentRequestCount, confirmByRef, takeConfirmed,
  createSession, resolveSession, destroySession,
};
