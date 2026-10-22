'use strict';
/**
 * Regression checks for two tester-reported bugs:
 *   1. "I marked it done but Wingman keeps reminding me" — done must close the
 *      task, its duplicates, its reminder automations and the goal step, and the
 *      assistant must never be told "done" when nothing was closed.
 *   2. "Wingman wrote to me in Urdu though I only write English" — language comes
 *      from how the user writes, never from their country/timezone.
 *   node scripts/test-done-and-language.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-done-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';

const dbm = require('../src/db');
dbm.initSchema();
const { db } = dbm;
const users = require('../src/db/users');
const convos = require('../src/db/conversations');
const tasks = require('../src/db/tasks');
const goals = require('../src/db/goals');
const automations = require('../src/db/automations');
const claude = require('../src/llm/claude');
const L = require('../src/utils/language');
const { executeTaskTool } = require('../src/engine/taskExecutor');
const { executeGoalTool } = require('../src/engine/goalExecutor');
const { buildSystemPrompt } = require('../src/engine/systemPrompt');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };
const isOpen = (id) => tasks.getById(id).completed === 0;

(async () => {
  let u = users.create({ phone: '923001233333' });
  users.update(u.id, { name: 'Sam Lee', onboarding_complete: 1, timezone: 'Asia/Karachi', language: 'ur' });
  for (const m of ['remind me to buy groceries at 6pm', 'also call Ali about the invoice', 'and call Ali about the design', 'thanks, what is on my calendar today?', 'mark groceries as done please']) {
    convos.logMessage({ userId: u.id, role: 'user', content: m });
  }
  u = users.getById(u.id);

  // ── 1. Done means done ───────────────────────────────────────────────
  const g1 = tasks.create({ userId: u.id, title: 'Buy groceries', dueDate: '2026-01-01T13:00:00.000Z' });
  const g2 = tasks.create({ userId: u.id, title: 'Buy groceries', source: 'google_tasks', dueDate: '2026-01-01T13:00:00.000Z' });
  const a1 = tasks.create({ userId: u.id, title: 'Call Ali about the invoice' });
  const a2 = tasks.create({ userId: u.id, title: 'Call Ali about the design' });
  const rem = automations.create(u.id, { instruction: 'Remind the user to buy groceries', time: '18:00', kind: 'daily', timezone: 'Asia/Karachi' });
  const other = automations.create(u.id, { instruction: 'Send the office traffic update', time: '08:00', kind: 'weekdays', timezone: 'Asia/Karachi' });

  const r = await executeTaskTool(u, { name: 'complete_task', input: { query: 'groceries' } });
  check('"groceries done" → completed', r.completed === true, JSON.stringify(r).slice(0, 160));
  check('…its duplicate (e.g. the Google Tasks copy) is closed too', !isOpen(g1.id) && !isOpen(g2.id) && r.duplicates_closed === 1);
  check('…its reminder automation is switched off', automations.getById(rem.id).active === 0 && r.stopped_reminders.length === 1);
  check('…unrelated automations untouched', automations.getById(other.id).active === 1);
  check('…no longer overdue (briefing/reminders read this)', !tasks.listOverdue(u.id, new Date().toISOString()).some((t) => /groceries/i.test(t.title)));

  const amb = await executeTaskTool(u, { name: 'complete_task', input: { query: 'call ali' } });
  check('two different tasks match → asks, closes nothing', amb.error === 'MULTIPLE_MATCHES' && amb.matches.length === 2 && isOpen(a1.id) && isOpen(a2.id));
  const byId = await executeTaskTool(u, { name: 'complete_task', input: { task_id: a2.id } });
  check('…then by task_id → exactly that one', byId.completed && !isOpen(a2.id) && isOpen(a1.id));
  const none = await executeTaskTool(u, { name: 'complete_task', input: { query: 'renew passport' } });
  check('no match → TASK_NOT_FOUND + open list + "do NOT tell the user it is done"', none.error === 'TASK_NOT_FOUND' && /Do NOT tell the user/.test(none.detail) && none.open_tasks.some((t) => t.task_id === a1.id));

  // Goal nudges: "done" must move the plan on.
  const goal = goals.create(u.id, { title: 'Start going to the gym', plan: [{ step: 'Find 2-3 gyms nearby and compare fees and timings', done: false }, { step: 'Sign up for a monthly plan', done: false }] });
  const bad = await executeGoalTool(u, { name: 'update_goal_progress', input: { goal: 'gym', step: 'learn to swim' } });
  check('goal step that does not match → STEP_NOT_FOUND, nothing claimed', bad.error === 'STEP_NOT_FOUND' && goals.getById(goal.id).plan.every((s) => !s.done));
  const nxt = await executeGoalTool(u, { name: 'update_goal_progress', input: { goal: 'gym', next_step_done: true } });
  check('"done" to the goal nudge → next step ticked', nxt.steps_marked_done.length === 1 && goals.getById(goal.id).plan[0].done === true && /Sign up/.test(nxt.goal.next_step));
  const para = await executeGoalTool(u, { name: 'update_goal_progress', input: { goal: 'gym', step: 'signed up for the monthly plan' } });
  check('a paraphrased step still matches', para.steps_marked_done.length === 1 && goals.getById(goal.id).plan[1].done === true);

  // ── 2. Language from how they write ─────────────────────────────────
  check('English writer in Karachi with language=ur on file → English', L.userLanguage(users.getById(u.id)) === 'english');
  check('system prompt tells the model: English only, never Urdu by location', /they write in English — reply ONLY in that language/.test(buildSystemPrompt(users.getById(u.id))));

  let plannerPrompt = '';
  claude.complete = async (p) => { plannerPrompt = p; return '{"steps":["Find a gym near you"],"ideas":[]}'; };
  await executeGoalTool(u, { name: 'create_goal', input: { title: 'Learn English' } });
  check('goal plans are written in the user\'s language', /^Write in: English/.test(plannerPrompt));

  const urduPlan = goals.create(u.id, { title: 'Get fit', plan: [{ step: 'Aaj hi 2-3 nazdeeki gyms ka fee aur timing pata karo (call ya Google Maps se)', done: false }] });
  claude.complete = async () => '["Today, find 2-3 nearby gyms and check their fees and timings (call or use Google Maps)"]';
  const fixed = await require('../src/services/goalCoach').fixPlanLanguage(goals.getById(urduPlan.id), 'english');
  check('an old Roman-Urdu plan is translated before nudging an English user', /^Today, find 2-3 nearby gyms/.test(fixed.plan[0].step) && /^Today/.test(goals.getById(urduPlan.id).plan[0].step));

  const ur = users.create({ phone: '923001233334' });
  for (const m of ['bhai kal 3 baje meeting rakh do', 'mujhe batao aaj kya hai', 'acha theek hai shukriya', 'ye task kar diya hai']) convos.logMessage({ userId: ur.id, role: 'user', content: m });
  check('Roman Urdu writer → Roman Urdu', L.userLanguage(users.getById(ur.id)) === 'roman_urdu');
  const keep = await require('../src/services/goalCoach').fixPlanLanguage({ id: 'x', plan: [{ step: 'Aaj gym jao', done: false }] }, 'roman_urdu');
  check('…and their Roman Urdu plan is left as is', keep.plan[0].step === 'Aaj gym jao');
  check('detector: English with "he" is not Urdu', !L.looksRomanUrdu('he said he will send the report by friday'));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
