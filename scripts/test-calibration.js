'use strict';
/**
 * Offline checks for "Wingman adapts to the user": learning how they write
 * (chat + sent mail), turning their corrections into permanent rules, and
 * putting both into every prompt. No network: the LLM and Gmail are stubbed.
 *   node scripts/test-calibration.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-calib-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';

const db = require('../src/db');
db.initSchema();
const users = require('../src/db/users');
const convos = require('../src/db/conversations');
const rules = require('../src/db/userRules');
const claude = require('../src/llm/claude');
const googleAuth = require('../src/auth/googleAuth');
const gmail = require('../src/services/gmail');
const style = require('../src/services/styleProfile');
const learner = require('../src/services/behaviorLearner');
const { executeBrainTool, rulesBlock } = require('../src/engine/brainExecutor');
const { buildSystemPrompt } = require('../src/engine/systemPrompt');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  let u = users.create({ phone: '923001237777' });
  users.update(u.id, { name: 'Aamir Younus', onboarding_complete: 1, timezone: 'Asia/Karachi', tone: 'friendly' });
  u = users.getById(u.id);

  // ── Default prompt: no hardcoded "witty + emojis" persona ───────────
  const before = buildSystemPrompt(u);
  check('base prompt no longer forces a witty/emoji persona', !/slightly witty/i.test(before) && !/Use emojis sparingly but effectively/.test(before));
  check('base prompt: corrections become permanent behavior rules', /kind "behavior"/.test(before));
  check('no style block before anything is learned', !/HOW AAMIR TALKS/.test(before));

  // ── Style: needs enough of their own words ─────────────────────────
  const thin = await style.build(u, { llm: async () => '{}' });
  check('too few messages → no profile (never invents a style)', thin.skipped === 'not_enough_samples', JSON.stringify(thin));

  const mine = ['bro ye check karo', 'acha theek ha', 'kal 3 baje meeting rakh do', 'bhai email bhejo ali ko', 'nahi yar ye galat ha',
    'shukriya bro', 'kitne baje ha?', 'ok kar do', 'haan bhej do', 'acha ye batao sales kitni hui'];
  for (const m of mine) { convos.logMessage({ userId: u.id, role: 'user', content: m }); convos.logMessage({ userId: u.id, role: 'assistant', content: 'Sure! 😊 Here you go...' }); }

  googleAuth.isEmailConnected = () => true;
  gmail.accountsFor = () => [{ id: 'a1', email: 'aamir@heard.pk' }];
  let gmailQuery = '';
  gmail.listMessageIds = async (user, { query }) => { gmailQuery = query; return ['s1', 's2', 's3', 's4']; };
  const sent = {
    s1: 'Hi Ali,\n\nPlease send the deck by Friday.\n\nBest,\nAamir\n\nOn Mon, 12 Oct 2026 at 10:00, Ali <ali@x.com> wrote:\n> old stuff here',
    s2: 'Hi Sara,\n\nLooping in Bilal for the invoice. Let me know if anything is missing.\n\nBest,\nAamir',
    s3: 'Hi team,\n\nQuick one: the launch moves to Monday. Thanks for the push this week.\n\nBest,\nAamir\nSent from my iPhone',
    s4: 'ok',
  };
  gmail.getMessage = async (user, id) => ({ subject: `S ${id}`, body: sent[id] });

  let seenPrompt = '';
  const fakeLlm = async (prompt) => {
    seenPrompt = prompt;
    return JSON.stringify({
      chat: { language: 'Roman Urdu mixed with English', length: 'very short, 1 line', formality: 'casual, says bro/yar', emoji: 'none', habits: ['says "bro"'], reply_guidance: 'Reply in short Roman Urdu, 1-3 lines, no emojis.' },
      email: { language: 'English', greeting: '"Hi Ali,"', signoff: '"Best,\\nAamir"', length: '2-4 lines', tone: 'direct', phrases: ['Quick one', 'Looping in'], draft_guidance: 'Open with Hi <name>, get to the point, sign Best, Aamir.' },
    });
  };
  const r = await style.build(u, { llm: fakeLlm });
  check('profile learned from chat + sent mail', r.profile && r.profile.chat && r.profile.email && r.profile.samples.chat === 10 && r.profile.samples.email === 3, JSON.stringify(r.profile && r.profile.samples));
  check('reads only SENT mail', /in:sent/.test(gmailQuery), gmailQuery);
  check('quoted reply + "Sent from my iPhone" stripped, too-short email skipped', !/old stuff/.test(seenPrompt) && !/Sent from my iPhone/.test(seenPrompt) && !/#4/.test(seenPrompt));
  check('only the USER\'s chat lines are studied, not Wingman\'s', /bro ye check karo/.test(seenPrompt) && !/Here you go/.test(seenPrompt));

  u = users.getById(u.id);
  const sys = buildSystemPrompt(u);
  check('prompt: "how they talk" block with their language + guidance', /HOW AAMIR TALKS/.test(sys) && /Roman Urdu mixed with English/.test(sys) && /no emojis/.test(sys));
  check('prompt: "writing emails as them" block with their sign-off', /WRITING EMAILS AS AAMIR/.test(sys) && /Best,/.test(sys) && /Quick one/.test(sys));
  check('email tool tells the model to write AS the user', /AS the user/.test(JSON.stringify(require('../src/engine/gmailTools'))));

  const again = await style.maybeBuild(users.getById(u.id));
  check('no rebuild right after building (cost guard)', !!again.skipped, JSON.stringify(again));
  users.updatePreferences(u.id, { styleTriedAt: new Date().toISOString() });
  const due = await style.runDue({ llm: fakeLlm });
  check('hourly sweep: one attempt per user per day', due.length === 0);

  // ── Corrections → permanent rules ──────────────────────────────────
  const saved = await executeBrainTool(u, { name: 'set_rule', input: { kind: 'behavior', about: 'Keep replies to 2-3 short lines' } });
  check('set_rule kind=behavior saves', saved.saved === true, JSON.stringify(saved));
  convos.logMessage({ userId: u.id, role: 'user', content: 'itna lamba kyun likhte ho, aur emoji mat lagao' });
  for (let i = 0; i < 10; i += 1) convos.logMessage({ userId: u.id, role: 'user', content: `msg ${i}` });
  claude.chat = async () => JSON.stringify({ facts: [{ fact: 'Runs Heard agency', category: 'context' }], rules: ["Don't use emojis", 'Keep replies to 2-3 short lines'] });
  const learned = await learner.learnForUser(u.id);
  check('learner turns their complaint into a rule (and skips the duplicate)', learned.rules.length === 1 && learned.rules[0] === "Don't use emojis", JSON.stringify(learned));
  check('learner still learns facts', learned.learned.length === 1);
  check('old array-style output still parses', learner.parseLearned('[{"fact":"x","category":"habit"}]').facts.length === 1);

  const rb = rulesBlock(u);
  check('rules block: their own rules first and marked as overriding', /THE USER'S OWN RULES FOR YOU/.test(rb) && /Don't use emojis/.test(rb) && /beat everything else/.test(rb));
  const other = rules.add(u.id, { kind: 'notify_mute', text: 'Newsletters' });
  check('other rule kinds still listed separately', other.added && /STANDING RULES THIS USER GAVE YOU/.test(rulesBlock(u)) && /Newsletters/.test(rulesBlock(u)));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
