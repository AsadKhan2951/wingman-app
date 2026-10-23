'use strict';
/**
 * Offline check of WhatsApp 24h-window handling, held messages and the
 * reply-to-verify sign-in. Uses a throwaway DB and a fake Cloud API — sends
 * nothing.  Run:  node scripts/test-whatsapp-window.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-window-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.WHATSAPP_TOKEN = 'test';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
process.env.PROACTIVE_TEMPLATE_NAME = 'wingman_notify';
process.env.OTP_USE_TEMPLATE = '0';
process.env.DISABLE_WHATSAPP = '1';
process.env.EXPOSE_OTP_IN_DEV = '0';

const db = require('../src/db');
db.initSchema();
const cloudApi = require('../src/whatsapp/cloudApi');
const sent = [];
cloudApi.ready = () => true;
cloudApi.sendText = async (to, text) => { sent.push({ kind: 'text', to, text }); return { messages: [{ id: `t${sent.length}` }] }; };
cloudApi.sendTemplate = async (to, name, lang, comps) => { sent.push({ kind: 'template', to, name, comps }); return { messages: [{ id: `p${sent.length}` }] }; };

const wa = require('../src/whatsapp/client');
const users = require('../src/db/users');
const conversations = require('../src/db/conversations');
const auth = require('../src/db/auth');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  const u = users.create({ phone: '923001112222' });
  users.update(u.id, { name: 'Test', onboarding_complete: 1 });
  const user = users.getById(u.id);

  // 1. Never messaged on WhatsApp → outside the window → template, not text.
  sent.length = 0;
  await wa.sendMessage(user.phone, 'Your bill for K-Electric is due tomorrow.');
  check('outside window → generic template', sent.length === 1 && sent[0].kind === 'template' && sent[0].name === 'wingman_notify');

  // 2. A second alert while that template is unanswered → held, no new ping.
  sent.length = 0;
  await wa.sendMessage(user.phone, 'Meeting notes: *Q3 review*\n\n• Decision A\n• Decision B');
  check('second alert while template unanswered → held quietly', sent.length === 0);

  // 3. Urgent messages still ping.
  sent.length = 0;
  await wa.sendMessage(user.phone, 'Wingman is knocking — admit it now.', { urgent: true });
  check('urgent → template even when one is waiting', sent.length === 1 && sent[0].kind === 'template');

  // 4. In-app chat must NOT open the WhatsApp window.
  conversations.logMessage({ userId: user.id, role: 'user', content: 'hi from the app', metadata: { direction: 'inbound', source: 'app' } });
  check('in-app chat does not count as WhatsApp inbound', !wa.isWithinCustomerWindow(user));

  // 5. Real WhatsApp inbound opens it; held messages are delivered.
  conversations.logInbound({ userId: user.id, content: 'ok', phoneNumber: user.phone, waMessageId: 'w1' });
  check('WhatsApp inbound opens the window', wa.isWithinCustomerWindow(user));
  sent.length = 0;
  const n = await wa.deliverHeld(user);
  check('held messages delivered on reply', n === 1 && sent.length === 1 && sent[0].kind === 'text' && /Q3 review/.test(sent[0].text));
  sent.length = 0;
  await wa.sendMessage(user.phone, 'Inside the window now.');
  check('inside window → free-form text', sent.length === 1 && sent[0].kind === 'text');

  // 6. Long message outside the window: template carries it flattened, full text held.
  const v = users.create({ phone: '923003334444' });
  users.update(v.id, { onboarding_complete: 1 });
  sent.length = 0;
  await wa.sendMessage('923003334444', `Long notes\n\n${'blah '.repeat(400)}`);
  const held = db.db.prepare('SELECT COUNT(*) n FROM held_messages WHERE user_id = ?').get(v.id).n;
  check('long message → template + full text held', sent.length === 1 && sent[0].kind === 'template' && held === 1);

  // 7. OTP for a brand-new number: never free-form outside the window.
  sent.length = 0;
  const ch = await wa.sendOtp('923009998888', '123456');
  check('OTP to a new number is not sent as (dropped) free-form', ch === false && sent.length === 0);

  // 8. Reply-to-verify.
  const otp = auth.createOtp('923009998888', { ttlSeconds: 600 });
  check('pending before the user messages', auth.takeConfirmed('923009998888', otp.pollSecret) === 'pending');
  const wrong = auth.confirmByRef('923000000000', otp.ref);
  check('ref sent from a different number is refused', !wrong.ok && wrong.reason === 'other_number');
  const ok = auth.confirmByRef('923009998888', otp.ref.toLowerCase());
  check('ref from the right number confirms and returns the code', ok.ok && ok.code === otp.code);
  check('app poll signs in once', auth.takeConfirmed('923009998888', otp.pollSecret) === 'confirmed');
  check('…and only once', auth.takeConfirmed('923009998888', otp.pollSecret) !== 'confirmed');
  check('wrong poll secret gets nothing', auth.takeConfirmed('923009998888', 'nope') === 'unknown');

  // 8b. "Resend" replaced the code: the OLD WM- message must not confirm the new
  // request (it may not be the user's — see test-security-fixes.js); the new one does.
  const first = auth.createOtp('923001230000', { ttlSeconds: 600 });
  const second = auth.createOtp('923001230000', { ttlSeconds: 600 });
  const late = auth.confirmByRef('923001230000', first.ref);
  check('old ref after a resend is refused', !late.ok && late.reason === 'expired'
    && auth.takeConfirmed('923001230000', second.pollSecret) === 'pending');
  check('new ref after a resend signs in', auth.confirmByRef('923001230000', second.ref).ok
    && auth.takeConfirmed('923001230000', second.pollSecret) === 'confirmed');
  const local = auth.createOtp('923001239999', { ttlSeconds: 600 });
  check('number format differences are tolerated', auth.confirmByRef('+92 300 1239999', local.ref).ok);

  // 8c. Alerts sent through sendProactiveMessage are coalesced too.
  const w = users.create({ phone: '923004445555' });
  users.update(w.id, { onboarding_complete: 1 });
  sent.length = 0;
  await wa.sendProactiveMessage(users.getById(w.id), 'New business email from A');
  await wa.sendProactiveMessage(users.getById(w.id), 'New business email from B');
  check('second proactive alert while template unanswered → held', sent.length === 1 && sent[0].kind === 'template');

  // 9. A sign-in message logged with no user yet still opens the window for that phone.
  conversations.logInbound({ userId: null, content: 'Sign me in: WM-ABCDEF', phoneNumber: '923007776666', waMessageId: 'w2' });
  const nu = users.create({ phone: '923007776666' });
  check('pre-signup WhatsApp message counts for the new user', wa.isWithinCustomerWindow(users.getById(nu.id)));

  // 10. Rate limit counter.
  for (let i = 0; i < 5; i += 1) auth.createOtp('923005550000', { ip: '1.2.3.4' });
  check('rate-limit counter sees recent requests', auth.recentRequestCount({ phone: '923005550000' }) === 5 && auth.recentRequestCount({ ip: '1.2.3.4' }) === 5);

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
