'use strict';
/**
 * Offline checks for briefing calls + voice notes (fake ElevenLabs and
 * WhatsApp — nothing is called or sent).   node scripts/test-briefing-call.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-call-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
process.env.WHATSAPP_TOKEN = 'test';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
process.env.ELEVENLABS_API_KEY = 'test';
process.env.ELEVENLABS_AGENT_ID = 'agent_test';
process.env.ELEVENLABS_CALLS = '1';
process.env.APP_STUDY = '0';
process.env.PROACTIVE_TEMPLATE_NAME = 'wingman_notify';
process.env.BRIEFING_TEMPLATE_NAME = 'wingman_schedule_reminder';
process.env.BRIEFING_TEMPLATE_STYLE = 'reminder';

const db = require('../src/db');
db.initSchema();

const sent = [];
const cloudApi = require('../src/whatsapp/cloudApi');
cloudApi.ready = () => true;
cloudApi.sendText = async (to, text) => { sent.push({ kind: 'text', text }); return { messages: [{ id: 'x' }] }; };
cloudApi.sendTemplate = async (to, name) => { sent.push({ kind: 'template', name }); return { messages: [{ id: 'y' }] }; };
cloudApi.sendAudio = async (to, buf, { mimeType }) => { sent.push({ kind: 'audio', mimeType, bytes: buf.length }); return {}; };

const el = require('../src/services/elevenlabs');
const calls = [];
let convResult = null;
el.startWhatsAppCall = async (args) => { calls.push(args); return { conversationId: `conv_${calls.length}`, message: 'ok' }; };
const phoneCalls = [];
el.startPhoneCall = async (args) => { phoneCalls.push(args); return { conversationId: `pconv_${phoneCalls.length}`, message: 'ok' }; };
el.getConversation = async () => convResult;
el.speak = async (text) => ({ buffer: Buffer.from(`OggS${text.slice(0, 20)}`), mimeType: 'audio/ogg' });

const claude = require('../src/llm/claude');
claude.complete = async () => 'english';
claude.chat = async () => '';

const conv = require('../src/engine/conversation');
conv.answerForCall = async (user, q) => `answer for ${user.name}: ${q}`;

const briefing = require('../src/services/morningBriefing');
const briefingCall = require('../src/services/briefingCall');
const users = require('../src/db/users');
const conversations = require('../src/db/conversations');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  const u = users.create({ phone: '923001112222' });
  users.update(u.id, { name: 'Aamir Younus', onboarding_complete: 1, timezone: 'Asia/Karachi' });
  let user = users.getById(u.id);

  check('calls off until the user turns them on', !briefingCall.shouldCall(user));
  briefingCall.setEnabled(user.id, true);
  user = users.getById(u.id);
  check('switch on → will call', briefingCall.shouldCall(user));

  // 1. A call is placed with the briefing + a per-call token.
  const r = await briefingCall.start(user, 'briefing', { now: new Date() });
  const args = calls[0] || {};
  const dv = args.dynamicVariables || {};
  check('call started with briefing text, name and token', r.started && dv.user_name === 'Aamir' && dv.briefing.length > 20 && dv.call_token.length >= 32);
  check('no second call while one is ringing', !briefingCall.shouldCall(users.getById(u.id)));

  // 2. Mid-call question reaches the brain only with the right token.
  const ok = await briefingCall.answer(dv.call_token, 'kal ki meetings?');
  const bad = await briefingCall.answer('wrong', 'x');
  check('agent questions answered for the right user', /Aamir/.test(ok.answer) && bad.error === 'UNKNOWN_CALL');

  // 3. Answered call → nothing sent, note in history.
  sent.length = 0;
  convResult = { status: 'done', metadata: { call_duration_secs: 180 }, transcript: [{ role: 'agent', message: 'hi' }, { role: 'user', message: 'ok go on' }], analysis: { transcript_summary: 'Went through 3 meetings.' } };
  await briefingCall.runPoll();
  const last = conversations.historyForUser(u.id, 3).pop();
  check('answered call: no WhatsApp message, call noted in history', sent.length === 0 && /Call/.test(last.content) && /3 meetings/.test(last.content));

  // 4. Missed call → text briefing goes out instead.
  await briefingCall.start(users.getById(u.id), 'briefing', { now: new Date() });
  sent.length = 0;
  convResult = { status: 'failed', metadata: { call_duration_secs: 0, termination_reason: 'no answer' }, transcript: [] };
  await briefingCall.runPoll();
  check('missed call → briefing sent as message', sent.some((m) => m.kind === 'template' || m.kind === 'text'));

  // 5. Second miss in a row → calls pause + the user is told.
  await briefingCall.start(users.getById(u.id), 'briefing', { now: new Date() });
  await briefingCall.runPoll();
  const told = conversations.historyForUser(u.id, 5).some((m) => /couldn't reach you/.test(m.content))
    || db.db.prepare('SELECT COUNT(*) n FROM held_messages WHERE user_id = ? AND text LIKE ?').get(u.id, "%couldn't reach you%").n > 0;
  check('two misses → user told calls are paused', told && briefingCall.consecutiveMissed(users.getById(u.id)) === 2);
  check('…and no more calls until they say so', !briefingCall.shouldCall(users.getById(u.id)));
  await new Promise((r) => setTimeout(r, 1100));
  briefingCall.setEnabled(u.id, true);
  check('"call me again" resumes calls', briefingCall.shouldCall(users.getById(u.id)));

  // 6. Full briefing (after "View Briefing") carries a voice note.
  conversations.logInbound({ userId: u.id, content: 'SHOW_BRIEFING', phoneNumber: '923001112222', waMessageId: 'w1' });
  sent.length = 0;
  await briefing.sendForUser(u.id, { now: new Date(), full: true });
  check('full briefing → text + voice note', sent.some((m) => m.kind === 'text') && sent.some((m) => m.kind === 'audio' && m.mimeType === 'audio/ogg'));

  // 7. Users who didn't opt in get no voice note.
  briefingCall.setEnabled(u.id, false);
  sent.length = 0;
  await briefing.sendForUser(u.id, { now: new Date(), full: true });
  check('voice briefings off → no voice note', !sent.some((m) => m.kind === 'audio'));

  // 8. Calls never start when the server isn't set up for them.
  delete process.env.ELEVENLABS_CALLS;
  briefingCall.setEnabled(u.id, true);
  check('ELEVENLABS_CALLS off → no calls (voice notes only)', !briefingCall.shouldCall(users.getById(u.id)) && briefingCall.wantsVoice(users.getById(u.id)));

  // 8b. Phone channel: a normal call to the user's number (no WhatsApp rules).
  process.env.ELEVENLABS_CALLS = '1';
  process.env.ELEVENLABS_CALL_CHANNEL = 'phone';
  const phu = users.create({ phone: '923331234567' });
  users.update(phu.id, { name: 'Bilal Khan', onboarding_complete: 1 });
  briefingCall.setEnabled(phu.id, true);
  check('phone channel without a number id → no calls', !briefingCall.shouldCall(users.getById(phu.id)));
  process.env.ELEVENLABS_PHONE_NUMBER_ID = 'phnum_test';
  check('phone channel ready once the Twilio number is imported', briefingCall.shouldCall(users.getById(phu.id)));
  const before = calls.length;
  const ps = await briefingCall.start(users.getById(phu.id), 'briefing', { now: new Date() });
  check('briefing goes out as a PHONE call to their number (not WhatsApp)', ps.started && phoneCalls.length === 1 && phoneCalls[0].toNumber === '923331234567' && calls.length === before && !!phoneCalls[0].dynamicVariables.briefing, JSON.stringify(ps));
  delete process.env.ELEVENLABS_CALL_CHANNEL;
  delete process.env.ELEVENLABS_PHONE_NUMBER_ID;
  delete process.env.ELEVENLABS_CALLS;

  // 9a. Inbound calls get an instant snapshot from synced data.
  const soon = new Date(Date.now() + 60 * 60000).toISOString();
  db.db.prepare("INSERT INTO calendar_events (id, user_id, title, start_time) VALUES ('ev1', ?, 'Design review with Sara', ?)").run(u.id, soon);
  db.db.prepare("INSERT INTO tasks (id, user_id, title, due_date) VALUES ('t1', ?, 'Send invoice to Hemani', ?)").run(u.id, new Date().toISOString().slice(0, 10));
  const snap = briefingCall.quickSnapshot(users.getById(u.id));
  check('inbound snapshot has today\'s meetings + tasks (no API calls)', /Design review with Sara/.test(snap) && /Send invoice to Hemani/.test(snap), snap.split('\n')[0]);

  // 9. The user calls Wingman — identified by number, gets their own token.
  const inb = await briefingCall.inbound({ caller_id: '+92 300 1112222', agent_id: 'agent_test', conversation_id: 'conv_in' });
  const iv = inb.dynamic_variables || {};
  check('inbound call: caller recognised by WhatsApp number', inb.type === 'conversation_initiation_client_data' && iv.user_name === 'Aamir' && iv.call_token.length >= 32);
  check('inbound call: agent gets the snapshot up front', /Design review with Sara/.test(iv.briefing));
  const ia = await briefingCall.answer(iv.call_token, 'meri meetings?');
  check('inbound call: questions answered from their data', /Aamir/.test(ia.answer || ''));
  const nested = await briefingCall.inbound({ whatsapp: { whatsapp_user_id: '923001112222' } });
  check('inbound call: number found in a nested payload too', nested.dynamic_variables.user_name === 'Aamir');
  const stranger = await briefingCall.inbound({ caller_id: '+15550001111' });
  check('unknown caller: no token, no data', stranger.dynamic_variables.call_token === '' && /sign up/.test(stranger.dynamic_variables.call_purpose));
  convResult = { status: 'done', metadata: { call_duration_secs: 95 }, transcript: [{ role: 'user', message: 'thanks' }], analysis: { transcript_summary: 'Asked about meetings.' } };
  sent.length = 0;
  await briefingCall.runPoll();
  const inNote = conversations.historyForUser(u.id, 3).pop();
  check('inbound call ends → noted in history, nothing sent', /called me/.test(inNote.content) && sent.length === 0);
  check('inbound calls never count as missed briefing calls', briefingCall.consecutiveMissed(users.getById(u.id)) === 0);

  // 10. Wingman's memory goes into the call.
  require('../src/db/userMemory').add(u.id, { fact: 'Prefers meetings after 11am', category: 'preference' });
  const inb2 = await briefingCall.inbound({ caller_id: '923001112222' });
  check('call gets Wingman\'s memory (facts + recent chat)', /after 11am/.test(inb2.dynamic_variables.brain) && /Them:|You:/.test(inb2.dynamic_variables.brain));

  // 11. ~30 min before the briefing: refresh + pre-build for callers.
  const pre = require('../src/services/preBriefing');
  check('lead time wraps past midnight', pre.minus('10:00', 30) === '09:30' && pre.minus('00:10', 30) === '23:40');
  users.update(u.id, { briefing_time: '10:00', debrief_time: '20:00', timezone: 'Asia/Karachi' });
  briefingCall.setEnabled(u.id, true);
  const nine35 = new Date('2026-10-13T04:35:00Z'); // 09:35 in Karachi
  const ran = await pre.runDue({ now: nine35 });
  const pu = users.getById(u.id);
  check('pre-briefing refresh runs 30 min before briefing time', ran.some((r) => r.user === u.id && r.kind === 'briefing'));
  check('…and pre-builds the briefing for callers', !!(pu.preferences.prebuilt && pu.preferences.prebuilt.text && pu.preferences.prebuilt.kind === 'briefing'));
  const again = await pre.runDue({ now: new Date('2026-10-13T04:40:00Z') });
  check('…only once a day', !again.some((r) => r.user === u.id));
  calls.length = 0;
  const startedAt = new Date(Date.parse(pu.preferences.prebuilt.at) + 30 * 60000);
  await briefingCall.start(pu, 'briefing', { now: startedAt });
  check('call at briefing time uses the pre-built briefing + memory', (calls[0].dynamicVariables.briefing || '').length > 20 && /after 11am/.test(calls[0].dynamicVariables.brain));

  // 12. Long lookups on a call: never silent — "working" now, answer later.
  const tok = iv.call_token;
  conv.answerForCall = async (user, q) => { await new Promise((r) => setTimeout(r, /flight/.test(q) ? 400 : 10)); return `answer: ${q}`; };
  const quick = await briefingCall.ask(tok, 'meri meetings?', '', { budgetMs: 150 });
  check('quick question → answered straight away', quick.answer === 'answer: meri meetings?');
  const slow = await briefingCall.ask(tok, 'aaj Abu Dhabi ki flights?', '', { budgetMs: 150 });
  check('slow lookup → "working" + job id + keep-talking instruction (no silence)', slow.status === 'working' && !!slow.job_id && /keep the conversation going/.test(slow.instruction));
  const early = await briefingCall.result(tok, slow.job_id, { waitMs: 50 });
  check('fetched too early → still working, keep chatting', early.status === 'working');
  const late = await briefingCall.result(tok, slow.job_id, { waitMs: 1000 });
  check('fetched after the user replied → the answer', late.answer === 'answer: aaj Abu Dhabi ki flights?');
  const other = await briefingCall.result('someone-else', slow.job_id);
  check('another call can\'t read this answer', !!other.error);
  const latest = await briefingCall.ask(tok, 'flight to Dubai?', '', { budgetMs: 50 });
  const byLatest = await briefingCall.result(tok, '', { waitMs: 1000 });
  check('wingman_result without id → latest lookup of this call', latest.status === 'working' && byLatest.answer === 'answer: flight to Dubai?');

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
