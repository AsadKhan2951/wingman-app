'use strict';
/**
 * "Your Google connection has expired" spam — regression checks.
 * Google OAuth + WhatsApp are stubbed; nothing real is called or sent.
 *   node scripts/test-google-health.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-gh-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';

const dbm = require('../src/db');
dbm.initSchema();
const users = require('../src/db/users');
const accts = require('../src/db/googleAccounts');
const wa = require('../src/whatsapp/client');
const { google } = require('googleapis');
const googleAuth = require('../src/auth/googleAuth');
const gc = require('../src/services/googleConnection');

const sent = [];
wa.sendMessage = async (phone, text) => { sent.push(text); return { ok: true }; };

// Fake Google: which refresh tokens still work, and who they belong to.
const live = new Map(); // refresh_token -> email
google.auth.OAuth2.prototype.getAccessToken = async function () {
  const rt = this.credentials && this.credentials.refresh_token;
  if (live.has(rt)) { this.credentials.access_token = `at-${rt}`; return { token: `at-${rt}` }; }
  throw new Error('unauthorized_client');
};
let nextGrant = null;
google.auth.OAuth2.prototype.getToken = async function () { return { tokens: nextGrant }; };
google.oauth2 = ({ auth }) => ({ userinfo: { get: async () => {
  const at = auth.credentials.access_token || '';
  const rt = at.replace(/^at-/, '') || auth.credentials.refresh_token;
  return { data: { email: live.get(rt) || live.get(auth.credentials.refresh_token) || null } };
} } });

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };
let clock = Date.now();
gc._setClock(() => clock);
const fail = (u, account) => gc.markBroken(u.id, { account, reason: 'unauthorized_client' });
const tok = (rt) => ({ refresh_token: rt, access_token: 'x', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar' });

(async () => {
  // ── A. Main account fine, an OLD connection (no email) is dead ──────
  const a = users.create({ phone: '923001110001' });
  users.update(a.id, { onboarding_complete: 1 });
  const orphan = accts.upsertByEmail(a.id, { email: null, token: tok('old-dead') }); // primary (first)
  live.set('rt-aamir', 'aamir@gmail.com');
  const good = accts.upsertByEmail(a.id, { email: 'aamir@gmail.com', token: tok('rt-aamir') });
  await fail(a, orphan);
  check('one failure → nobody pinged', sent.length === 0);
  clock += 11 * 60e3;
  await fail(a, orphan);
  check('old dead connection + working account → working one becomes primary', accts.getPrimary(a.id).id === good.id);
  check('…and the user is NOT pinged (main account works)', sent.length === 0, sent.join(' | '));
  check('…main data not treated as stale', !gc.isBroken(users.getById(a.id)));

  // ── B. Main account really dead → one clear message, then quiet ─────
  const b = users.create({ phone: '923001110002' });
  users.update(b.id, { onboarding_complete: 1 });
  const bAcc = accts.upsertByEmail(b.id, { email: 'sam@work.com', token: tok('sam-dead') });
  clock = Date.now();
  await fail(b, bAcc); clock += 11 * 60e3; await fail(b, bAcc);
  check('dead main account → told once, naming it, link pre-selects it', sent.length === 1 && /sam@work\.com/.test(sent[0]) && /hint=sam%40work\.com/.test(sent[0]), sent[0]);
  for (let i = 0; i < 20; i++) { clock += 3600e3; await fail(b, bAcc); }
  check('…not again for 3 days (20 more failures over 20h)', sent.length === 1);
  for (let i = 0; i < 12; i++) { clock += 24 * 3600e3; await fail(b, bAcc); }
  check('…at most 3 reminders in total, ever', sent.filter((x) => /sam@work/.test(x)).length === 3);

  // ── C. Reconnect actually FIXES it (old dead row is replaced) ───────
  const c = users.create({ phone: '923001110003' });
  users.update(c.id, { onboarding_complete: 1 });
  const cOld = accts.upsertByEmail(c.id, { email: null, token: tok('c-old-dead') });
  clock = Date.now();
  const before = sent.length;
  await fail(c, cOld); clock += 11 * 60e3; await fail(c, cOld);
  check('only connection is dead → told (generic: no email known)', sent.length === before + 1 && /older Google connection/.test(sent[sent.length - 1]));
  live.set('c-new', 'c@gmail.com');
  nextGrant = tok('c-new');
  await googleAuth.handleCallback('code', '923001110003');
  const rows = accts.listForUser(c.id);
  check('reconnect REPLACES the dead old row (no second row left failing)', rows.length === 1 && rows[0].id === cOld.id && rows[0].email === 'c@gmail.com' && JSON.parse(rows[0].token).refresh_token === 'c-new', JSON.stringify(rows.map((r) => [r.email, r.is_primary])));
  check('…state cleared', gc.brokenAccounts(users.getById(c.id)).length === 0 && !gc.isBroken(users.getById(c.id)));
  check('…legacy columns carry the new token', /c-new/.test(users.getById(c.id).calendar_token || ''));

  // Reconnecting a DIFFERENT, working account while the primary is dead → it becomes primary.
  const d = users.create({ phone: '923001110004' });
  users.update(d.id, { onboarding_complete: 1 });
  accts.upsertByEmail(d.id, { email: 'old@x.com', token: tok('d-dead') });
  live.set('d-new', 'new@x.com');
  nextGrant = tok('d-new');
  await googleAuth.handleCallback('code', '923001110004');
  check('reconnect with another account while primary is dead → new one is primary', accts.getPrimary(d.id).email === 'new@x.com');

  // ── D. A success clears only that account ──────────────────────────
  const e = users.create({ phone: '923001110005' });
  users.update(e.id, { onboarding_complete: 1 });
  const e1 = accts.upsertByEmail(e.id, { email: 'e1@x.com', token: tok('e1') });
  const e2 = accts.upsertByEmail(e.id, { email: 'e2@x.com', token: tok('e2-dead') });
  clock = Date.now();
  await fail(e, e2); clock += 11 * 60e3; await fail(e, e2);
  gc.markOk(e.id, { account: e1 });
  check('second inbox dead: main data NOT stale, state kept for e2 only', !gc.isBroken(users.getById(e.id)) && gc.brokenAccounts(users.getById(e.id)).join() === 'e2@x.com');
  check('…its message says the main account is fine', /other Google account \*e2@x\.com\*.*main account is fine/.test(sent[sent.length - 1]), sent[sent.length - 1]);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
