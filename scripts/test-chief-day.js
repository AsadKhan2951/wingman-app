'use strict';
/**
 * Offline checks for the chief-of-staff day:
 *   4. replies drafted in the user's voice before they ask, sent on their go
 *      through the normal approval gate;
 *   3. the briefing says what Wingman is handling + what needs a yes, and the
 *      wrap says what Wingman did and what's still waiting.
 * LLM, Gmail and WhatsApp are stubbed.
 *   node scripts/test-chief-day.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-day-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPOSIO_AUTH_CONFIGS = '{"slack":"ac_1"}';

const dbm = require('../src/db');
dbm.initSchema();
const { db } = dbm;
const users = require('../src/db/users');
const convos = require('../src/db/conversations');
const emailItems = require('../src/db/emailItems');
const googleAuth = require('../src/auth/googleAuth');
const gmail = require('../src/services/gmail');
const drafter = require('../src/services/replyDrafter');
const cos = require('../src/services/chiefOfStaff');
require('../src/engine/conversation'); // registers the real built-in runner
const { executeReplyTool } = require('../src/engine/replyTools');
const ie = require('../src/engine/integrationExecutor');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  let u = users.create({ phone: '923001234444' });
  users.update(u.id, { name: 'Aamir Younus', onboarding_complete: 1, timezone: 'Asia/Karachi' });
  users.updatePreferences(u.id, {
    styleProfile: { email: { greeting: '"Hi Ali,"', signoff: '"Best, Aamir"', draft_guidance: 'Short, direct, signs Best, Aamir.' } },
    profileCard: { text: 'PRIORITIES RIGHT NOW:\n- Hemani BI deal\nKEY PEOPLE:\n- VIP: Ali Raza — client', at: new Date().toISOString(), fp: 'x' },
  });
  require('../src/db/userRules').add(u.id, { kind: 'behavior', text: 'Never apologise for delays in emails' });
  u = users.getById(u.id);

  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  emailItems.upsert(u.id, { gmailId: 'g1', subject: 'Pricing for the BI dashboard?', sender: 'Ali Raza <ali@client.com>', category: 'needs_reply', actionNeeded: true, receivedAt: ago(2) });
  emailItems.upsert(u.id, { gmailId: 'g2', subject: 'Your weekly digest', sender: 'LinkedIn <noreply@linkedin.com>', category: 'needs_reply', receivedAt: ago(3) });
  emailItems.upsert(u.id, { gmailId: 'g3', subject: 'Old thread', sender: 'Sam <sam@x.com>', category: 'needs_reply', receivedAt: ago(24 * 6) });
  emailItems.upsert(u.id, { gmailId: 'g4', subject: 'Thanks!', sender: 'Sara <sara@x.com>', category: 'needs_reply', receivedAt: ago(1) });
  emailItems.upsert(u.id, { gmailId: 'webmail:12', subject: 'Order #88 delayed?', sender: 'Customer <c@shop.com>', category: 'urgent', receivedAt: ago(4) });

  // ── 4. Drafted replies ──────────────────────────────────────────────
  const cands = drafter.candidates(u.id, 10).map((r) => r.gmail_id);
  check('drafts only for real people who need a reply, recent ones', cands.includes('g1') && cands.includes('webmail:12') && !cands.includes('g2') && !cands.includes('g3'), cands.join(','));

  googleAuth.isEmailConnected = () => true;
  gmail.accountsFor = () => [null];
  gmail.getMessage = async (user, id) => ({ gmailId: id, threadId: 't1', subject: id === 'g1' ? 'Pricing for the BI dashboard?' : 'Thanks!', sender: id === 'g1' ? 'Ali Raza <ali@client.com>' : 'Sara <sara@x.com>', body: id === 'g1' ? 'Hi Aamir, what would the BI dashboard cost per month? Can we start next week?' : 'Thanks, all good!' });
  let seen = '';
  const llm = async (prompt) => {
    seen = prompt;
    if (/Thanks, all good/.test(prompt)) return '{"reply":"","needs_input":null,"skip":true}';
    return JSON.stringify({ reply: 'Hi Ali,\n\nHappy to start next week. The dashboard is [monthly price] per month.\n\nBest, Aamir', needs_input: 'What monthly price should I quote Ali?' });
  };
  const items = Object.fromEntries(db.prepare('SELECT id, gmail_id FROM email_items WHERE user_id = ?').all(u.id).map((r) => [r.gmail_id, r.id]));
  const d1 = await drafter.draftFor(u, emailItems.getById(u.id, items.g1), { llm });
  check('reply drafted', d1.drafted === true, JSON.stringify(d1));
  check('…written from their style, manual and rules', /Best, Aamir/.test(seen) && /PRIORITIES RIGHT NOW/.test(seen) && /Never apologise/.test(seen) && /what would the BI dashboard cost/.test(seen));
  const row1 = emailItems.getById(u.id, items.g1);
  check('…leaves a [gap] and asks for the missing fact', /\[monthly price\]/.test(row1.prepared_reply) && /monthly price/.test(row1.prepared_note));
  const d4 = await drafter.draftFor(u, emailItems.getById(u.id, items.g4), { llm });
  check('a thank-you that closes the thread → no draft, not retried', d4.skipped === 'no_reply_needed' && !drafter.candidates(u.id, 10).some((r) => r.gmail_id === 'g4'));

  const block = drafter.promptBlock(users.getById(u.id));
  check('chat knows the draft (so "bhej do" works)', block.includes(items.g1) && /send_prepared_reply/.test(block) && !block.includes(items.g4));
  const list = await executeReplyTool(u, { name: 'list_prepared_replies', input: {} }, {});
  check('list_prepared_replies shows who + what it needs', list.replies.length === 1 && list.replies[0].from === 'Ali Raza' && /monthly price/.test(list.replies[0].needs_from_user));

  const gap = await executeReplyTool(u, { name: 'send_prepared_reply', input: { email_item_id: items.g1 } }, {});
  check('never sends a draft that still has a [gap]', gap.error === 'DRAFT_HAS_GAP', JSON.stringify(gap));
  const finalBody = 'Hi Ali,\n\nHappy to start next week. The dashboard is PKR 250,000 per month.\n\nBest, Aamir';
  const parked = await executeReplyTool(u, { name: 'send_prepared_reply', input: { email_item_id: items.g1, body: finalBody } }, {});
  check('send goes through the normal approval gate', parked.approval_required === true && !emailItems.getById(u.id, items.g1).replied, JSON.stringify(parked).slice(0, 120));
  const sent = [];
  gmail.sendMessage = async (user, msg) => { sent.push(msg); return { id: 'm1' }; };
  convos.logMessage({ userId: u.id, role: 'user', content: 'haan bhej do' });
  const ok = await ie.executeIntegrationTool(u, { name: 'approve_integration_action', input: { action_id: parked.action_id } }, {});
  check('on their yes the reply goes out, threaded, with their final text', ok.done && sent.length === 1 && sent[0].to === 'ali@client.com' && sent[0].threadId === 't1' && /PKR 250,000/.test(sent[0].body), JSON.stringify(ok).slice(0, 160));
  const after = emailItems.getById(u.id, items.g1);
  check('…email marked replied, draft cleared', after.replied === 1 && !after.prepared_reply && !!after.replied_at);
  emailItems.upsert(u.id, { gmailId: 'g1', subject: 'Pricing for the BI dashboard?', sender: 'Ali Raza <ali@client.com>', category: 'needs_reply', receivedAt: ago(2) });
  check('…and stays replied when the inbox is re-scanned', emailItems.getById(u.id, items.g1).replied === 1);
  check('business-mail drafts reply from the business mailbox', drafter.sendPlan({ gmail_id: 'webmail:12' }, 'x').tool === 'reply_business_email' && drafter.sendPlan({ gmail_id: 'webmail:12' }, 'x').input.uid === 12);

  // ── 3. Chief-of-staff day ───────────────────────────────────────────
  emailItems.setPrepared(u.id, items['webmail:12'], { reply: 'Hi, your order ships tomorrow. Best, Aamir', note: null });
  db.prepare("INSERT INTO followups (id, user_id, type, description, counterparty, status) VALUES ('f1', ?, 'promise_received', 'Send data access (from \"Hemani kickoff\")', 'Ali Raza', 'open')").run(u.id);
  require('../src/db/userRules').add(u.id, { kind: 'auto_approve', text: 'Replies to ali@client.com', toolkit: 'builtin', toolSlug: 'reply_to_email', scope: 'ali@client.com' });
  require('../src/db/tasks').create({ userId: u.id, title: 'Send invoice', dueDate: ago(48) });
  db.prepare("INSERT INTO meeting_followups (id, user_id, meeting_id, title, items, attendees, status) VALUES ('fu1', ?, 'm1', 'Follow-up: Hemani kickoff', '[\"Data access\"]', '[{\"name\":\"Ali Raza\",\"email\":\"ali@client.com\"}]', 'pending')").run(u.id);
  u = users.getById(u.id);
  const plan = cos.morningPlan(u, { eventsToday: [{}, {}] });
  check('briefing: what Wingman is handling today', /On it today/.test(plan) && /Prep notes before your 2 meetings/.test(plan) && /1 reply drafted in your voice/.test(plan) && /people owe you \(Ali — Send data access\)/.test(plan) && /Handling without asking: Replies to ali@client.com/.test(plan), plan);
  check('briefing: what needs their yes', /Needs your yes/.test(plan) && /Reply → Customer: "Order #88 delayed\?"/.test(plan) && /Book follow-up: Hemani kickoff \(Ali\)/.test(plan) && /1 overdue task/.test(plan) && /show replies/.test(plan));

  require('../src/db/agentActions').log(u.id, { kind: 'integration.reply_to_email', summary: 'Reply to email g1: Hi Ali…', source: 'chat' });
  require('../src/db/agentActions').log(u.id, { kind: 'integration.reply_to_email', summary: '(without asking) Reply to email g9: ok', source: 'auto' });
  const rep = cos.eveningReport(u);
  check('wrap: what Wingman did today (incl. without-asking)', /Done for you today/.test(rep) && /Reply to Ali Raza/.test(rep) && /⚡ Reply to email g9/.test(rep), rep);
  check('wrap: still waiting on them + who owes them', /Still waiting on you/.test(rep) && /Customer/.test(rep) && /follow-up/i.test(rep) && !/Sara/.test(rep) && !/LinkedIn/.test(rep) && /Others still owe you/.test(rep) && /Ali: Send data access/.test(rep));

  users.updatePreferences(u.id, { styleProfile: { chat: { language: 'Roman Urdu mixed with English' } } });
  const ur = cos.morningPlan(users.getById(u.id), { eventsToday: [] });
  check('Roman Urdu for users who talk that way', /Aaj main sambhal raha hoon/.test(ur) && /Tumhara haan chahiye/.test(ur), ur.split('\n')[0]);

  const mb = require('../src/services/morningBriefing');
  const text = mb.format(users.getById(u.id), { tz: 'Asia/Karachi', weather: { city: 'Karachi', temp: 30, condition: 'Clear' }, events: [], emailConnected: false, tasksDue: [], bills: [], deliveries: [] });
  check('the plan is inside the morning briefing', /sambhal raha hoon/.test(text) && /Tasks Due Today/.test(text));
  const empty = users.create({ phone: '923001234445' });
  check('nothing real → no chief-of-staff section (no fake claims)', cos.morningPlan(users.getById(empty.id), { eventsToday: [] }) === '' && cos.eveningReport(users.getById(empty.id)) === '');

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
