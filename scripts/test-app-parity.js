'use strict';
/**
 * Offline checks for the tester issues: deleting/editing tasks, email times and
 * order, Gmail vs business, "pending/cancellation" emails in chat, needs-
 * attention parity with the app, and expired Google connections.
 *   node scripts/test-app-parity.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-parity-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'ELEVENLABS_API_KEY', 'COMPOSIO_API_KEY']) delete process.env[k];
process.env.PUBLIC_BASE_URL = 'https://app.example.com';

const wa = require('../src/whatsapp/client');
const sent = [];
wa.sendMessage = async (phone, text) => { sent.push(text); return { ok: true }; };

const db = require('../src/db');
db.initSchema();
const users = require('../src/db/users');
const tasks = require('../src/db/tasks');
const emailItems = require('../src/db/emailItems');
const gmail = require('../src/services/gmail');
const googleAuth = require('../src/auth/googleAuth');
const gc = require('../src/services/googleConnection');
const { executeTaskTool } = require('../src/engine/taskExecutor');
const { executeRecordsTool } = require('../src/engine/recordsExecutor');
const { executeGmailTool } = require('../src/engine/gmailExecutor');
const { buildSystemPrompt } = require('../src/engine/systemPrompt');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  let u = users.create({ phone: '923001239999' });
  users.update(u.id, { name: 'Aamir', onboarding_complete: 1, timezone: 'Asia/Karachi', webmail_address: 'info@heard.pk' });
  u = users.getById(u.id);

  // ── Tasks: delete + edit ────────────────────────────────────────────
  const a = tasks.create({ userId: u.id, title: 'Call Ali about invoice' });
  tasks.create({ userId: u.id, title: 'Call Ali about design' });
  const c = tasks.create({ userId: u.id, title: 'Buy groceries' });
  const amb = await executeTaskTool(u, { name: 'delete_task', input: { query: 'call ali' } });
  check('delete "call ali" with 2 matches → asks which one', amb.error === 'MULTIPLE_MATCHES' && amb.matches.length === 2);
  const del = await executeTaskTool(u, { name: 'delete_task', input: { task_id: a.id } });
  check('delete by task_id → gone', del.deleted && !tasks.getById(a.id));
  const del2 = await executeTaskTool(u, { name: 'delete_task', input: { query: 'groceries' } });
  check('delete by phrase → gone', del2.deleted && !tasks.getById(c.id));
  const none = await executeTaskTool(u, { name: 'delete_task', input: { query: 'nothing like this' } });
  check('unknown task → TASK_NOT_FOUND', none.error === 'TASK_NOT_FOUND');
  const up = await executeTaskTool(u, { name: 'update_task', input: { query: 'design', title: 'Call Ali about the logo', priority: 1, due_date: '2026-10-20T15:00:00+05:00' } });
  check('update_task renames + priority + due', up.updated && up.task.title === 'Call Ali about the logo' && up.task.priority === 1 && !!up.task.due_label, JSON.stringify(up.task));
  const cl = await executeTaskTool(u, { name: 'update_task', input: { query: 'logo', due_date: 'none' } });
  check('update_task "none" clears the deadline', cl.updated && cl.task.due_date === null);

  // ── Emails in the app list: real received time, newest first ────────
  emailItems.upsert(u.id, { gmailId: 'g1', subject: 'Old invoice', sender: 'Hemani <a@hemani.com>', category: 'needs_reply', summary: 'Invoice question', receivedAt: '2026-10-13T06:00:00.000Z' });
  emailItems.upsert(u.id, { gmailId: 'webmail:7', accountEmail: 'info@heard.pk', subject: 'Order #55 cancelled', sender: 'Shop <s@shop.com>', category: 'fyi', summary: 'Your order was cancelled', detectedType: 'cancellation', receivedAt: '2026-10-15T09:30:00.000Z' });
  emailItems.upsert(u.id, { gmailId: 'g2', subject: 'Lunch?', sender: 'Sara <sara@x.com>', category: 'urgent', summary: 'Asks about lunch', receivedAt: '2026-10-14T11:00:00.000Z' });
  const all = await executeRecordsTool(u, { name: 'email_overview', input: {} });
  check('email_overview: newest first by RECEIVED time', all.emails && all.emails.map((e) => e.subject).join('|') === 'Order #55 cancelled|Lunch?|Old invoice', all.emails && all.emails.map((e) => e.subject).join('|'));
  check('…each labelled Gmail or business, with a local received time', all.emails[0].mailbox === 'business' && all.emails[1].mailbox === 'gmail' && /2:30 PM|14:30/.test(all.emails[0].received), all.emails[0].received);
  const pend = await executeRecordsTool(u, { name: 'email_overview', input: { view: 'needs_reply' } });
  check('"pending emails" → only the ones waiting on a reply', pend.emails.length === 2 && pend.emails.every((e) => e.needs_reply));
  const canc = await executeRecordsTool(u, { name: 'email_overview', input: { type: 'cancellation' } });
  check('"cancellation emails" → found', canc.emails.length === 1 && /cancelled/.test(canc.emails[0].subject));
  const biz = await executeRecordsTool(u, { name: 'email_overview', input: { mailbox: 'business' } });
  check('business-only filter', biz.emails.length === 1 && biz.emails[0].account === 'info@heard.pk');
  const srch = await executeRecordsTool(u, { name: 'email_overview', input: { search: 'hemani' } });
  check('"emails from Hemani" → found', srch.emails.length === 1 && srch.emails[0].from === 'Hemani');

  // ── Needs attention = the app's Home card ──────────────────────────
  tasks.create({ userId: u.id, title: 'Send report', dueDate: '2026-01-01T09:00:00.000Z' });
  const att = await executeRecordsTool(u, { name: 'needs_attention', input: {} });
  check('needs_attention: overdue tasks + emails waiting', att.overdue_tasks.some((x) => x.title === 'Send report') && att.emails_waiting_reply.length === 2 && att.total >= 3, `total ${att.total}`);

  // ── Gmail live list: inbox only, dates, newest first across accounts ──
  googleAuth.isEmailConnected = () => true;
  gmail.accountsFor = () => [{ id: 'acc1', email: 'aamir@gmail.com' }, { id: 'acc2', email: 'aamir@heard.pk' }];
  const queries = [];
  gmail.listMessageIds = async (user, { query, account }) => { queries.push(query); return account.id === 'acc1' ? ['m1', 'm2'] : ['m3']; };
  const meta = {
    m1: { gmailId: 'm1', sender: 'A <a@a.com>', subject: 'Older', snippet: '', labelIds: ['INBOX'], receivedAt: '2026-10-15T03:00:00.000Z' },
    m2: { gmailId: 'm2', sender: 'B <b@b.com>', subject: 'Newest', snippet: '', labelIds: ['INBOX', 'UNREAD'], receivedAt: '2026-10-15T10:05:00.000Z' },
    m3: { gmailId: 'm3', sender: 'C <c@c.com>', subject: 'Middle', snippet: '', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], receivedAt: '2026-10-15T07:00:00.000Z' },
  };
  gmail.getMessageMeta = async (user, id) => meta[id];
  const live = await executeGmailTool(u, { name: 'list_recent_emails', input: {} });
  check('list_recent_emails: inbox only (no sent mail mixed in)', queries.every((q) => /in:inbox/.test(q)), queries.join(','));
  check('…merged across accounts, newest first', live.emails.map((e) => e.subject).join('|') === 'Newest|Middle|Older', live.emails && live.emails.map((e) => e.subject).join('|'));
  check('…with local time, unread and category', /3:05 PM|15:05/.test(live.emails[0].received) && live.emails[0].unread && live.emails[1].category === 'promotions', live.emails[0].received);

  // ── Google connection expired → never "no new emails" ───────────────
  gmail.listMessageIds = async () => { throw new Error('unauthorized_client'); };
  const dead = await executeGmailTool(u, { name: 'list_recent_emails', input: {} });
  check('expired Google → GOOGLE_RECONNECT_NEEDED (not "no emails")', dead.error === 'GOOGLE_RECONNECT_NEEDED', JSON.stringify(dead).slice(0, 120));
  u = users.getById(u.id);
  check('…user flagged + told ONCE on WhatsApp with the reconnect link', gc.isBroken(u) && sent.filter((x) => /reconnect/i.test(x)).length === 1 && /auth\/google\?/.test(sent[0]));
  await executeGmailTool(u, { name: 'list_recent_emails', input: {} });
  check('…not told again the same day', sent.filter((x) => /reconnect/i.test(x)).length === 1);
  check('…assistant prompt warns that Google data may be old', /GOOGLE CONNECTION EXPIRED/.test(gc.promptBlock(users.getById(u.id))));
  gc.markOk(u.id);
  check('reconnect clears the flag', !gc.isBroken(users.getById(u.id)) && gc.promptBlock(users.getById(u.id)) === '');

  // ── Prompt rules ───────────────────────────────────────────────────
  const sys = buildSystemPrompt(users.getById(u.id));
  check('prompt: never send the user to the app for information', /NEVER tell the user to "check the app"/.test(sys));
  check('prompt: delete_task + both mailboxes + received times', /delete_task/.test(sys) && /check BOTH/.test(sys) && /"received"/.test(sys));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
