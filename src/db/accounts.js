'use strict';

/**
 * Login accounts — email + password, Google, Apple. See schema.sql `accounts`.
 * Passwords are hashed with scrypt (Node built-in); tokens are stored hashed.
 */

const crypto = require('crypto');
const { db, uuid } = require('./index');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  const got = crypto.scryptSync(String(password), salt, expected.length, { N, r: SCRYPT.r, p: SCRYPT.p });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const getById = (id) => (id ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) : null) || null;
const getByEmail = (email) => db.prepare('SELECT * FROM accounts WHERE email = ?').get(normalizeEmail(email)) || null;

function getByProvider(provider, sub) {
  if (!sub) return null;
  const col = provider === 'apple' ? 'apple_sub' : 'google_sub';
  return db.prepare(`SELECT * FROM accounts WHERE ${col} = ?`).get(String(sub)) || null;
}

function create({ email = null, password = null, name = null, googleSub = null, appleSub = null, emailVerified = false } = {}) {
  const id = uuid();
  db.prepare(`
    INSERT INTO accounts (id, email, password_hash, google_sub, apple_sub, name, email_verified)
    VALUES (@id, @email, @hash, @googleSub, @appleSub, @name, @verified)
  `).run({
    id,
    email: email ? normalizeEmail(email) : null,
    hash: password ? hashPassword(password) : null,
    googleSub: googleSub ? String(googleSub) : null,
    appleSub: appleSub ? String(appleSub) : null,
    name: name ? String(name).trim().slice(0, 80) : null,
    verified: emailVerified ? 1 : 0,
  });
  return getById(id);
}

function update(id, patch = {}) {
  const cols = [];
  const vals = { id };
  const map = {
    name: 'name', userId: 'user_id', googleSub: 'google_sub', appleSub: 'apple_sub',
    emailVerified: 'email_verified', email: 'email',
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue;
    cols.push(`${col} = @${k}`);
    vals[k] = k === 'email' ? normalizeEmail(patch[k]) : (k === 'emailVerified' ? (patch[k] ? 1 : 0) : patch[k]);
  }
  if (patch.password !== undefined) { cols.push('password_hash = @hash'); vals.hash = hashPassword(patch.password); }
  if (!cols.length) return getById(id);
  db.prepare(`UPDATE accounts SET ${cols.join(', ')} WHERE id = @id`).run(vals);
  return getById(id);
}

function touchLogin(id) {
  db.prepare("UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

function listForUser(userId) {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at').all(userId);
}

// ── one-time tokens ────────────────────────────────────────────────────
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function issueToken(accountId, purpose, ttlMinutes) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  db.prepare('INSERT INTO account_tokens (token_hash, account_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha(token), accountId, purpose, expiresAt);
  return token;
}

/** → the account the token belongs to, or null. `consume` marks it used. */
function readToken(token, purpose, { consume = false } = {}) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM account_tokens WHERE token_hash = ? AND purpose = ?').get(sha(token), purpose);
  if (!row || row.used || Date.parse(row.expires_at) < Date.now()) return null;
  if (consume) db.prepare('UPDATE account_tokens SET used = 1 WHERE token_hash = ?').run(row.token_hash);
  return getById(row.account_id);
}

/** Public view — never the hash or provider ids. */
function toPublic(a) {
  if (!a) return null;
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    has_password: !!a.password_hash,
    google: !!a.google_sub,
    apple: !!a.apple_sub,
    linked: !!a.user_id,
  };
}

module.exports = {
  normalizeEmail, validEmail, hashPassword, verifyPassword,
  getById, getByEmail, getByProvider, create, update, touchLogin, listForUser,
  issueToken, readToken, toPublic,
};
