'use strict';
/**
 * Offline checks for sign up / sign in (email+password, Google/Apple account
 * logic, linking to WhatsApp). Real HTTP against a temp server + temp DB;
 * WhatsApp is off, so OTP codes come back in the response (dev mode).
 *   node scripts/test-accounts.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-acc-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
// Never send anything real: no WhatsApp credentials inside the test, even
// when it runs in the production container.
for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'ELEVENLABS_API_KEY']) delete process.env[k];
process.env.EXPOSE_OTP_IN_DEV = '1';
process.env.NODE_ENV = 'test';
process.env.PUBLIC_BASE_URL = 'https://app.example.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.APPLE_TEAM_ID = 'TEAM123';
process.env.APPLE_SERVICES_ID = 'ai.example.signin';
process.env.APPLE_KEY_ID = 'KEY123';
process.env.APPLE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');

const wa = require('../src/whatsapp/client');
wa.ready = () => false;
wa.sendOtp = async () => false;
const db = require('../src/db');
db.initSchema();
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../src/api/authRoutes'));

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const users = require('../src/db/users');
  const accounts = require('../src/db/accounts');

  const prov = await (await fetch(`${base}/providers`)).json();
  check('providers: email on, Apple on when configured, Google off', prov.email && prov.apple && !prov.google && prov.phone);

  // 1. Sign up → needs the WhatsApp number.
  const su = await post('/signup', { name: 'Aamir Younus', email: 'Aamir@Example.com ', password: 'secret123' });
  check('sign up → needs_phone + account token', su.status === 200 && su.body.status === 'needs_phone' && su.body.account_token && su.body.account.email === 'aamir@example.com');
  check('password stored hashed, never plain', !/secret123/.test(JSON.stringify(db.db.prepare('SELECT * FROM accounts').all())));

  // 2. Verify WhatsApp with the account token → linked + signed in.
  const otp = await post('/request-otp', { phone: '923001234567' });
  const ver = await post('/verify-otp', { phone: '923001234567', code: otp.body.dev_code, account_token: su.body.account_token });
  check('WhatsApp verified → signed in, account linked', ver.body.status === 'signed_in' && ver.body.token && ver.body.account && ver.body.account.linked);
  check('…and the user gets the name from sign up', ver.body.user.name === 'Aamir Younus');
  const reuse = await post('/verify-otp', { phone: '923001234567', code: otp.body.dev_code, account_token: su.body.account_token });
  check('account token / code can\'t be reused', reuse.status === 400);

  // 3. Log in later with email + password → straight in.
  const li = await post('/login', { email: 'aamir@example.com', password: 'secret123' });
  check('login → signed in to the same user', li.body.status === 'signed_in' && li.body.user.id === ver.body.user.id);
  const bad = await post('/login', { email: 'aamir@example.com', password: 'wrong-pass' });
  check('wrong password → 401', bad.status === 401);
  const dup = await post('/signup', { name: 'X', email: 'aamir@example.com', password: 'other-pass1' });
  check('same email again → 409 "sign in instead"', dup.status === 409);
  const again = await post('/signup', { name: 'Aamir', email: 'aamir@example.com', password: 'secret123' });
  check('sign up again with the same password → just signs in', again.body.status === 'signed_in');

  // 4. An existing WhatsApp-only user signs up → joins their old account.
  const old = users.create({ phone: '923339998888' });
  users.update(old.id, { name: 'Sara Khan', onboarding_complete: 1 });
  db.db.prepare("INSERT INTO tasks (id, user_id, title) VALUES ('t-old', ?, 'Old task')").run(old.id);
  const su2 = await post('/signup', { name: 'Sara', email: 'sara@example.com', password: 'password9' });
  const otp2 = await post('/request-otp', { phone: '923339998888' });
  const ver2 = await post('/verify-otp', { phone: '923339998888', code: otp2.body.dev_code, account_token: su2.body.account_token });
  check('old phone user + new email → same user, data kept, name kept', ver2.body.user.id === old.id && ver2.body.user.name === 'Sara Khan'
    && db.db.prepare("SELECT COUNT(*) n FROM tasks WHERE user_id = ?").get(old.id).n === 1);
  const me = await (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${ver2.body.token}` } })).json();
  check('/me lists the linked logins', Array.isArray(me.accounts) && me.accounts.some((a) => a.email === 'sara@example.com'));

  // 5. Old users can still sign in with just the phone.
  const otp3 = await post('/request-otp', { phone: '923339998888' });
  const ph = await post('/verify-otp', { phone: '923339998888', code: otp3.body.dev_code });
  check('phone-only sign in still works', ph.body.status === 'signed_in' && ph.body.user.id === old.id);

  // 6. Forgot password → code on WhatsApp → new password.
  const fg = await post('/forgot', { email: 'aamir@example.com' });
  check('forgot → code sent to the linked WhatsApp (masked hint)', fg.body.sent && /4567$/.test(fg.body.phone_hint));
  const rs = await post('/reset', { email: 'aamir@example.com', code: fg.body.dev_code, password: 'newpass123' });
  check('reset → signed in', rs.body.status === 'signed_in');
  const li2 = await post('/login', { email: 'aamir@example.com', password: 'newpass123' });
  const li3 = await post('/login', { email: 'aamir@example.com', password: 'secret123' });
  check('new password works, old one doesn\'t', li2.body.status === 'signed_in' && li3.status === 401);
  const fgNone = await post('/forgot', { email: 'nobody@example.com' });
  check('forgot for unknown email → clear 404', fgNone.status === 404);

  // 7. Google/Apple account logic.
  const routes = require('../src/api/accountRoutes');
  const g1 = routes.providerAccount('google', { sub: 'g-1', email: 'new@gmail.com', emailVerified: true, name: 'New Person' });
  const g1b = routes.providerAccount('google', { sub: 'g-1', email: 'new@gmail.com', emailVerified: true, name: 'New Person' });
  check('Google: same person → same account', g1.id === g1b.id && g1.email === 'new@gmail.com' && g1.email_verified === 1);
  const hijack = routes.providerAccount('google', { sub: 'g-2', email: 'aamir@example.com', emailVerified: true, name: 'Someone' });
  check('Google never joins an UNVERIFIED email account (no takeover)', hijack.id !== li.body.account.id && hijack.email === null);
  const a1 = routes.providerAccount('apple', { sub: 'a-1', email: 'new@gmail.com', emailVerified: true, name: null });
  check('Apple with a verified email joins the verified Google account', a1.id === g1.id && !!accounts.getById(g1.id).apple_sub);
  const code = accounts.issueToken(g1.id, 'exchange', 5);
  const ex = await post('/exchange', { code });
  const ex2 = await post('/exchange', { code });
  check('redirect code → needs_phone once; can\'t be reused', ex.body.status === 'needs_phone' && ex2.status === 400);

  // 8. Apple client secret is a valid ES256 JWT.
  const jwt = routes.appleClientSecret();
  const [h, p, sig] = jwt.split('.');
  const okSig = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  check('Apple client secret signed correctly', okSig && claims.iss === 'TEAM123' && claims.sub === 'ai.example.signin');

  // 9. Google start without config → friendly error back in the app.
  const gs = await fetch(`${base}/google/start`, { redirect: 'manual' });
  check('Google off → redirects back to the app with an error', gs.status === 302 && /auth-callback\?error=/.test(gs.headers.get('location')));
  const as = await fetch(`${base}/apple/start`, { redirect: 'manual' });
  check('Apple on → redirects to appleid.apple.com', as.status === 302 && /^https:\/\/appleid\.apple\.com\/auth\/authorize/.test(as.headers.get('location')));

  // 10. Deleting a user removes their logins.
  users.deleteUserCascade(old.id);
  check('account deletion removes the logins too', !accounts.getByEmail('sara@example.com'));

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
