'use strict';
/**
 * Offline checks for the chief-of-staff layer:
 *   1. the Operating Manual is built from EVERYTHING Wingman holds (people,
 *      calendar, email, tasks, goals, meetings, decisions, style) and leads
 *      every prompt;
 *   2. earned autonomy: after enough yeses for the same kind of action Wingman
 *      offers to stop asking, and only after the user agrees does that kind run
 *      without a yes — never money/deletes/forwards, never from automated runs.
 * No network: LLM and the action runner are stubbed.
 *   node scripts/test-chief-of-staff.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-cos-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPOSIO_AUTH_CONFIGS = '{"slack":"ac_1"}';

const dbm = require('../src/db');
dbm.initSchema();
const { db } = dbm;
const users = require('../src/db/users');
const convos = require('../src/db/conversations');
const actions = require('../src/db/integrationActions');
const claude = require('../src/llm/claude');
const ie = require('../src/engine/integrationExecutor');
const autonomy = require('../src/services/autonomy');
const profile = require('../src/services/userProfile');
const { executeBrainTool } = require('../src/engine/brainExecutor');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  let u = users.create({ phone: '923001235555' });
  users.update(u.id, { name: 'Aamir Younus', onboarding_complete: 1, timezone: 'Asia/Karachi', runs_business: 1 });
  u = users.getById(u.id);
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins("INSERT INTO email_items (id, user_id, gmail_id, subject, sender, category, received_at) VALUES ('e1', ?, 'g1', 'Order', 'Ali Raza <ali@client.com>', 'needs_reply', datetime('now'))", u.id);
  ins("INSERT INTO email_items (id, user_id, gmail_id, subject, sender, category, received_at) VALUES ('e2', ?, 'g2', 'Hi', 'Bob <bob@x.com>', 'urgent', datetime('now'))", u.id);

  // ── 2. Earned autonomy ───────────────────────────────────────────────
  const ran = [];
  ie.setBuiltinRunner(async (user, slug, args) => { ran.push({ slug, args }); return { sent: true, to: slug === 'reply_to_email' ? (args.email_id === 'g1' ? 'ali@client.com' : 'bob@x.com') : args.to }; });
  const say = (t) => convos.logMessage({ userId: u.id, role: 'user', content: t });
  const proposeAndApprove = async (slug, args) => {
    const p = await ie.gateBuiltin(u, slug, args, {}, async () => { throw new Error('should be parked'); });
    say('haan');
    return ie.executeIntegrationTool(u, { name: 'approve_integration_action', input: { action_id: p.action_id } }, {});
  };

  let last;
  for (let i = 1; i <= 3; i += 1) last = await proposeAndApprove('reply_to_email', { email_id: 'g1', body: `ok ${i}` });
  check('3 yeses → no offer yet', last.done && !last.autonomy_offer);
  // A decline resets the streak.
  const p4 = await ie.gateBuiltin(u, 'reply_to_email', { email_id: 'g1', body: 'nah' }, {}, async () => ({}));
  actions.cancel(u.id, p4.action_id);
  for (let i = 1; i <= 3; i += 1) last = await proposeAndApprove('reply_to_email', { email_id: 'g1', body: `again ${i}` });
  check('a "no" resets trust (3 after a decline → still no offer)', !last.autonomy_offer);
  last = await proposeAndApprove('reply_to_email', { email_id: 'g1', body: 'fourth' });
  check('4 yeses in a row → offers to stop asking, scoped to that person', last.autonomy_offer && last.autonomy_offer.what === 'Replies to ali@client.com', JSON.stringify(last.autonomy_offer));
  const key = last.autonomy_offer.offer_key;
  last = await proposeAndApprove('reply_to_email', { email_id: 'g1', body: 'fifth' });
  check('offer is not repeated', !last.autonomy_offer);

  const forged = await executeBrainTool(u, { name: 'grant_autonomy', input: { offer_key: 'send_email|ceo@bank.com' } }, {});
  check('cannot grant something never offered', forged.error === 'NO_OPEN_OFFER');
  const autoGrant = await executeBrainTool(u, { name: 'grant_autonomy', input: { offer_key: key } }, { automated: true });
  check('automated run cannot accept an offer', autoGrant.error === 'NEEDS_USER_CONFIRMATION');
  const g = await executeBrainTool(u, { name: 'grant_autonomy', input: { offer_key: key } }, {});
  check('user said yes → saved', g.granted === true, JSON.stringify(g));

  ran.length = 0;
  const auto = await ie.gateBuiltin(u, 'reply_to_email', { email_id: 'g1', body: 'quick reply' }, {}, async () => { ran.push('now'); return { sent: true, to: 'ali@client.com' }; });
  check('reply to Ali now goes without asking', auto.auto_approved === true && ran.length === 1, JSON.stringify(auto));
  check('…and is recorded as done in the history', db.prepare("SELECT COUNT(*) n FROM integration_actions WHERE user_id = ? AND summary LIKE '(without asking)%' AND status = 'done'").get(u.id).n === 1);
  const bob = await ie.gateBuiltin(u, 'reply_to_email', { email_id: 'g2', body: 'x' }, {}, async () => ({ sent: true }));
  check('a reply to someone else still asks', bob.approval_required === true);
  const fromAuto = await ie.gateBuiltin(u, 'reply_to_email', { email_id: 'g1', body: 'x' }, { automated: true }, async () => ({ sent: true }));
  check('automated run never skips the yes', !fromAuto.auto_approved);

  check('money/deletes/forward/share can never be earned', ['book_ride', 'delete_event', 'forward_email', 'share_drive_file', 'delete_drive_file']
    .every((s) => autonomy.kindOf(u.id, 'builtin', s, { to: 'a@b.com' }) === null));
  check('risky app tools can never be earned', autonomy.kindOf(u.id, 'stripe', 'STRIPE_CREATE_CHARGE', {}) === null && autonomy.kindOf(u.id, 'slack', 'SLACK_DELETE_MESSAGE', {}) === null);

  const listed = await executeBrainTool(u, { name: 'list_rules', input: {} }, {});
  check('user can see (and remove) what Wingman may do without asking', JSON.stringify(listed).includes('Replies to ali@client.com'));

  // ── 1. Operating Manual ──────────────────────────────────────────────
  ins("INSERT INTO contacts (id, user_id, name, email, company, interaction_count, last_contacted_at) VALUES ('c1', ?, 'Ali Raza', 'ali@client.com', 'Hemani', 14, datetime('now'))", u.id);
  ins("INSERT INTO calendar_events (id, user_id, gcal_event_id, title, start_time, end_time, attendees) VALUES ('ev1', ?, 'x1', 'Weekly sales sync', ?, ?, '[\"ali@client.com\"]')", u.id, new Date(Date.now() - 86400e3).toISOString(), new Date(Date.now() - 86400e3 + 3600e3).toISOString());
  ins("INSERT INTO tasks (id, user_id, title, priority) VALUES ('t1', ?, 'Finish Hemani BI proposal', 1)", u.id);
  ins("INSERT INTO meetings (id, user_id, title, meeting_at, summary) VALUES ('m1', ?, 'Hemani kickoff', ?, ?)", u.id, new Date().toISOString(), JSON.stringify({ overview: 'Kicked off BI dashboard.', decisions: ['Weekly reports on Monday'] }));
  ins("INSERT INTO followups (id, user_id, type, description, counterparty, status) VALUES ('f1', ?, 'promise_received', 'Send data access', 'Ali Raza', 'open')", u.id);
  users.updatePreferences(u.id, { styleProfile: { chat: { reply_guidance: 'Short Roman Urdu' } } });
  db.prepare("INSERT INTO user_memory (id, user_id, fact, category, source) VALUES ('mm1', ?, 'Runs Heard, an AI creative studio', 'context', 'learned')").run(u.id);

  let prompt = '';
  claude.complete = async (p) => { prompt = p; return 'WHO: Aamir — founder of Heard\nPRIORITIES RIGHT NOW:\n- Hemani BI proposal\nKEY PEOPLE:\n- VIP: Ali Raza — Hemani, reply fast\nWHAT YOU CAN HANDLE FOR THEM:\n- Replies to Ali'; };
  const r = await profile.refresh(u.id, { force: true });
  check('manual built', r.updated === true, JSON.stringify(r));
  check('…from the people they deal with most', /PEOPLE THEY DEAL WITH MOST/.test(prompt) && /Ali Raza <ali@client.com>, Hemani · 14 interactions/.test(prompt));
  check('…their calendar rhythm', /Weekly sales sync/.test(prompt) && /People they meet most: ali@client.com/.test(prompt));
  check('…email that needs them', /Who sends them mail that needs them: .*(Ali Raza|Bob)/.test(prompt));
  check('…open tasks, loops and recent meeting decisions', /Finish Hemani BI proposal/.test(prompt) && /Owed to them by Ali Raza/.test(prompt) && /Weekly reports on Monday/.test(prompt));
  check('…how they decided on proposals + what is already allowed', /HOW THEY DECIDED/.test(prompt) && /Replies to ali@client.com: approved \d+, declined 1/.test(prompt) && /Already allowed without asking: Replies to ali@client.com/.test(prompt));
  check('…how they communicate', /Short Roman Urdu/.test(prompt));

  const kb = require('../src/services/appStudy').knowledgeBlock(users.getById(u.id));
  check('manual leads the prompt as the operating manual', /OPERATING MANUAL/.test(kb) && /PRIORITIES RIGHT NOW/.test(kb) && /bring them decisions/.test(kb));

  const again = await profile.refresh(u.id);
  check('not rebuilt when nothing changed (cost guard)', again.skipped === 'fresh');

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
