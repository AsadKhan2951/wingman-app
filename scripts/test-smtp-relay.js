'use strict';
/**
 * Offline checks for sending business mail through the user's OWN mail server
 * via the Cloudflare relay (no network: fetch and IMAP are stubbed).
 *   node scripts/test-smtp-relay.js
 * The Worker itself is tested against a real SMTP server separately.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-relay-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-for-relay-checks-0123456789';
process.env.SMTP_RELAY_URL = 'https://relay.example.workers.dev';
process.env.SMTP_RELAY_SECRET = 'sek';
delete process.env.BREVO_API_KEY;

const db = require('../src/db');
db.initSchema();
const users = require('../src/db/users');
const webmail = require('../src/services/webmail');
const { ImapFlow } = require('imapflow');
const { executeWebmailTool } = require('../src/engine/webmailExecutor');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

// Stub IMAP: reading the original + the Sent-folder copy.
const appended = [];
ImapFlow.prototype.connect = async function () {};
ImapFlow.prototype.logout = async function () {};
ImapFlow.prototype.list = async function () { return [{ path: 'INBOX' }, { path: 'INBOX.Sent', specialUse: '\\Sent' }]; };
ImapFlow.prototype.append = async function (p, raw, flags) { appended.push({ p, raw: String(raw), flags }); return {}; };
ImapFlow.prototype.getMailboxLock = async function () { return { release() {} }; };
ImapFlow.prototype.download = async function () {
  const { Readable } = require('stream');
  return { content: Readable.from([Buffer.from('From: Ali <ali@shop.com>\r\nTo: info@heard.pk\r\nSubject: Order #55\r\nMessage-ID: <orig-1@shop.com>\r\n\r\nWhere is my order?\r\n')]) };
};

// Stub the relay.
let posted = [];
let relayReply = () => ({ status: 200, body: { ok: true, accepted: ['ali@shop.com'] } });
global.fetch = async (url, opts) => {
  posted.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  const r = relayReply();
  return { ok: r.status === 200, status: r.status, json: async () => r.body };
};

(async () => {
  let u = users.create({ phone: '923001230001' });
  webmail.saveForUser(u.id, { address: 'info@heard.pk', password: 'pw', imapHost: 'mail.heard.pk', imapPort: 993, smtpHost: 'mail.heard.pk', smtpPort: 465, fromName: 'Heard' });
  u = users.getById(u.id);

  // Reply → goes through the relay as the user, threaded, and lands in Sent.
  const r = await executeWebmailTool(u, { name: 'reply_business_email', input: { uid: 7, body: 'Hi Ali, your order ships today.\n\nAamir' } });
  const p = posted[0] && posted[0].body;
  check('reply sent', r.sent === true && r.to === 'ali@shop.com' && r.subject === 'Re: Order #55', JSON.stringify(r));
  check('…through the relay with the relay secret', posted.length === 1 && posted[0].headers['X-Relay-Secret'] === 'sek');
  check('…logged in as the user on THEIR smtp server', p.host === 'mail.heard.pk' && p.port === 465 && p.secure === true && p.user === 'info@heard.pk' && p.pass === 'pw');
  check('…from their address to the original sender', p.from === 'info@heard.pk' && p.to[0] === 'ali@shop.com');
  check('…threaded (In-Reply-To / References)', /In-Reply-To: <orig-1@shop.com>/.test(p.raw) && /References: <orig-1@shop.com>/.test(p.raw));
  check('…From shows their name + address', /From: Heard <info@heard.pk>/.test(p.raw), (p.raw.match(/^From:.*$/m) || [])[0]);
  check('…copy saved in their Sent folder', appended.length === 1 && appended[0].p === 'INBOX.Sent' && appended[0].raw === p.raw && appended[0].flags.includes('\\Seen'));

  // Wrong SMTP password → clear NOT-sent error, no Sent copy.
  posted = []; appended.length = 0;
  relayReply = () => ({ status: 502, body: { ok: false, stage: 'auth', code: 535, error: 'AUTH PLAIN → 535 Incorrect authentication data' } });
  const bad = await executeWebmailTool(u, { name: 'reply_business_email', input: { uid: 7, body: 'x' } });
  check('wrong password → WEBMAIL_AUTH_FAILED + "NOT sent"', bad.error === 'WEBMAIL_AUTH_FAILED' && /NOT sent/.test(bad.detail) && appended.length === 0, JSON.stringify(bad));

  // Mail server unreachable from the relay → clear NOT-sent error.
  relayReply = () => ({ status: 502, body: { ok: false, stage: 'connect', code: 'ECONNREFUSED', error: 'connect refused' } });
  const down = await executeWebmailTool(u, { name: 'send_business_email', input: { to: 'x@y.com', subject: 's', body: 'b' } });
  check('server unreachable → NOT sent, said plainly', /NOT sent/.test(down.detail || '') && /^WEBMAIL_/.test(down.error), JSON.stringify(down));

  // Recipient refused.
  relayReply = () => ({ status: 502, body: { ok: false, stage: 'rcpt_to', error: 'no recipient accepted' } });
  const rr = await executeWebmailTool(u, { name: 'send_business_email', input: { to: 'nobody@y.com', subject: 's', body: 'b' } });
  check('recipient refused → WEBMAIL_RECIPIENT_REJECTED', rr.error === 'WEBMAIL_RECIPIENT_REJECTED', JSON.stringify(rr));

  // Setup check verifies the SMTP login through the relay.
  posted = [];
  relayReply = () => ({ status: 200, body: { ok: true, verified: true } });
  const cap = await webmail.testConnection({ address: 'info@heard.pk', password: 'pw', imapHost: 'mail.heard.pk', smtpHost: 'mail.heard.pk', smtpPort: 587 });
  check('connect: SMTP login checked via relay (587 = STARTTLS)', cap.canSend && cap.via === 'relay' && posted[0].body.verify === true && posted[0].body.secure === false, JSON.stringify(cap));
  relayReply = () => ({ status: 502, body: { ok: false, stage: 'auth', code: 535, error: 'bad' } });
  const cap2 = await webmail.testConnection({ address: 'info@heard.pk', password: 'pw', imapHost: 'mail.heard.pk', smtpHost: 'mail.heard.pk', smtpPort: 465 });
  check('connect: bad SMTP login reported (reading still works)', cap2.ok && !cap2.canSend && cap2.sendError === 'WEBMAIL_AUTH_FAILED', JSON.stringify(cap2));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
