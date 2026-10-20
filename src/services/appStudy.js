'use strict';

/**
 * App study — how Wingman comes to UNDERSTAND whatever a user connects.
 *
 * One generic routine for every app (Shopify, Slack, Facebook, HubSpot, …):
 * give the model that app's READ-ONLY tools, let it look around, and have it
 * write a note for its future self — what the app holds, who/what matters,
 * the patterns, how it can help, and where it must ask first. There is no
 * per-app code: a newly offered app is studied the same way the day it's added.
 *
 * Timeline (told to the user up front, in their own language):
 *   minute 0  first look            → a short "here's what I found"
 *   day 1     patterns
 *   day 3     deeper
 *   day 7     full picture          → "I've got it now"; then refreshed weekly
 *
 * The notes live in app_knowledge and are injected into every chat
 * (knowledgeBlock). Only summaries are stored, never raw data.
 *
 * Gmail / Calendar / Tasks are learned by onboardingAnalyzer (same idea, older
 * code); its profile is surfaced in knowledgeBlock too.
 *
 * Everything is best-effort and off the request path: a failed study never
 * breaks a chat turn, a connect, or the schedulers.
 */

const config = require('../config');
const claude = require('../llm/claude');
const usersRepo = require('../db/users');
const knowledge = require('../db/appKnowledge');
const memory = require('../db/userMemory');
const t = require('../utils/time');

// Days until the next study, indexed by how many studies have been done.
const NEXT_IN_DAYS = [1, 1, 2, 4];      // after run 1 → +1d, run 2 → +2d, run 3 → +4d  (≈ day 7)
const REFRESH_DAYS = 7;                 // once the picture is full
const FULL_AFTER_RUNS = 4;
const BUILTIN = new Set(['shopify']);   // apps not connected through Composio
const RESULT_CAP = 6000;                // chars of one tool result shown to the model
const ACTIVE_FROM = 9;
const ACTIVE_TO = 21;

const busy = new Set();                 // `${userId}:${app}` currently being studied
let chain = Promise.resolve();          // studies run one at a time, server-wide

function enabled() {
  return config.study.enabled && !!config.anthropic.apiKey;
}

function wa() { return require('../whatsapp/client'); }
function composio() { return require('./composio'); }

function appName(app) {
  if (app === 'shopify') return 'Shopify';
  try { return composio().appName(app); } catch (_) { return app; }
}

function firstName(user) {
  return String((user && user.name) || '').trim().split(/\s+/)[0] || '';
}

// ── the tools the model may look around with (read-only, per source) ───

async function sourceFor(user, app) {
  if (app === 'shopify') {
    if (!user.shopify_domain || !user.shopify_token) return null;
    const { shopifyTools } = require('../engine/shopifyTools');
    const { executeShopifyTool } = require('../engine/shopifyExecutor');
    return {
      tools: shopifyTools.filter((x) => x.name !== 'get_shopify_connect_link'),
      run: (name, input) => executeShopifyTool(user, { name, input }),
    };
  }
  if (!config.composio.enabled) return null;
  const tools = await composio().readTools(app);
  if (!tools.length) return null;
  return {
    tools,
    run: async (name, input) => {
      const r = await composio().executeReadOnly(user, name, input);
      return r.ok ? r.data : { error: r.error };
    },
  };
}

// ── the study itself ────────────────────────────────────────────────────

const FINISH_TOOL = {
  name: 'finish_study',
  description: 'Call this once, when you have looked around enough, to save what you understood.',
  input_schema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description: 'Your note to your future self about this app and this user (max ~1500 characters). Use the headings from your instructions.',
      },
      summary: {
        type: 'string',
        description: '1–2 plain, friendly sentences telling the user what you found. No jargon, no headings.',
      },
      facts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 durable one-line facts about the USER (not the app) worth remembering, third person.',
      },
      question: {
        type: 'string',
        description: 'At most ONE short, specific question that would confirm something important you inferred. Empty string if none.',
      },
    },
    required: ['note', 'summary'],
  },
};

function studySystem(user, app, previous) {
  const name = appName(app);
  return `You are Wingman, a personal AI chief of staff. Your user${firstName(user) ? ` (${firstName(user)})` : ''} has connected their ${name} account. Right now you are NOT doing a task for them — you are studying ${name} so that you genuinely understand their world and can act well later without asking obvious questions.

You have READ-ONLY tools for ${name}. You cannot change anything. Look around like a sharp new assistant on day one:
1. Start broad — what is in here, how much, how recent.
2. Then go where it matters — the people, items, channels, products, customers or campaigns that recur; what is active versus dead; what looks important or urgent; how this person actually uses it.
3. Stop when more looking would not change your picture. Don't loop on a failing tool — note it and move on.

Then call finish_study. Write "note" for your future self using these headings (skip one if you have nothing real to say):
WHAT THIS IS: one line — what they use ${name} for.
KEY THINGS: the real names and numbers that matter (people, products, pages, channels, amounts).
PATTERNS: how they use it, rhythms, what performs, what's neglected.
MATTERS MOST: what this user would want to be told about or helped with here.
HOW I CAN HELP: concrete things you could do for them in ${name}.
ASK FIRST: actions here that should always get their yes (anything public, money, or hard to undo).
UNKNOWN: what you could not see or are unsure about.

Rules:
- Only what the data shows. Real names and numbers, never guesses. If the account is empty or a tool keeps failing, say exactly that.
- Never record passwords, tokens, card or bank numbers, or the full text of private messages — a summary of what they are about is enough.
- "note" must stay under about 1500 characters. It replaces your previous note, so keep what is still true.
${previous ? `\nYour previous note (written ${previous.when}) — verify it, correct what changed, and go deeper than last time:\n"""\n${previous.note}\n"""` : '\nThis is your FIRST look, so favour breadth: get the overall picture quickly.'}`;
}

function cap(obj) {
  let s;
  try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (_) { s = '[unserialisable result]'; }
  return s.length > RESULT_CAP ? `${s.slice(0, RESULT_CAP)}… [cut]` : s;
}

/**
 * Let the model explore one app and return { note, summary, facts, question }.
 * Returns null if it produced nothing usable.
 */
async function explore(user, app, source, previous) {
  const system = studySystem(user, app, previous);
  const tools = [...source.tools, FINISH_TOOL];
  const convo = [{ role: 'user', content: `Study my ${appName(app)} now.` }];
  const maxRounds = previous ? 9 : 6;

  for (let round = 0; round < maxRounds; round++) {
    const last = round === maxRounds - 1;
    const response = await claude.chatWithTools(convo, {
      system: last ? `${system}\n\nYou are out of time: call finish_study NOW with what you have.` : system,
      tools: last ? [FINISH_TOOL] : tools,
      maxTokens: 1800,
    });
    const uses = (response.content || []).filter((b) => b.type === 'tool_use');
    const done = uses.find((b) => b.name === 'finish_study');
    if (done) return done.input || null;
    if (!uses.length) {
      // It answered in prose instead of calling the tool — nudge once.
      convo.push({ role: 'assistant', content: response.content });
      convo.push({ role: 'user', content: 'Save it by calling finish_study.' });
      continue;
    }
    convo.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const b of uses) {
      let out;
      try { out = await source.run(b.name, b.input || {}); }
      catch (e) { out = { error: String(e.message || e).slice(0, 200) }; }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: cap(out) });
    }
    convo.push({ role: 'user', content: results });
  }
  return null;
}

function agoText(sqliteUtc) {
  const ms = Date.parse(`${String(sqliteUtc || '').replace(' ', 'T')}Z`);
  if (!ms) return 'earlier';
  const h = Math.round((Date.now() - ms) / 3600000);
  if (h < 1) return 'just now';
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Study one app for one user and save the result.
 * @returns {Promise<{ok:boolean, app:string, summary?:string, question?:string, full?:boolean, skipped?:string}>}
 */
async function studyApp(userId, app) {
  const key = `${userId}:${app}`;
  if (busy.has(key)) return { ok: false, app, skipped: 'already_running' };
  busy.add(key);
  try {
    const user = usersRepo.getById(userId);
    if (!user) return { ok: false, app, skipped: 'no_user' };
    knowledge.ensure(userId, app);
    const row = knowledge.get(userId, app);

    let source;
    try { source = await sourceFor(user, app); }
    catch (e) { knowledge.saveFailure(userId, app, e.message); return { ok: false, app, skipped: 'source_error' }; }
    if (!source) {
      // Disconnected (or nothing readable) — stop scheduling it.
      knowledge.remove(userId, app);
      return { ok: false, app, skipped: 'not_connected' };
    }

    const previous = row && row.note ? { note: row.note, when: agoText(row.studied_at) } : null;
    let out;
    try {
      out = await explore(user, app, source, previous);
    } catch (e) {
      console.warn(`[study] ${app} for ${userId} failed:`, e.message);
      knowledge.saveFailure(userId, app, e.message);
      return { ok: false, app, skipped: 'study_error' };
    }
    if (!out || !String(out.note || '').trim()) {
      knowledge.saveFailure(userId, app, 'no note produced');
      return { ok: false, app, skipped: 'empty' };
    }

    const runsAfter = ((row && row.runs) || 0) + 1;
    const full = runsAfter >= FULL_AFTER_RUNS;
    knowledge.saveStudy(userId, app, {
      note: String(out.note).trim(),
      nextInDays: full ? REFRESH_DAYS : NEXT_IN_DAYS[Math.min(runsAfter, NEXT_IN_DAYS.length - 1)],
      ready: full,
    });
    for (const f of (Array.isArray(out.facts) ? out.facts : []).slice(0, 5)) {
      try { if (typeof f === 'string') memory.add(userId, { fact: f, category: 'context', source: 'learned' }); }
      catch (_) { /* memory is best-effort */ }
    }
    console.log(`[study] ${app} for ${userId}: run ${runsAfter}${full ? ' (full picture)' : ''}`);
    return {
      ok: true, app, full, runs: runsAfter,
      summary: String(out.summary || '').trim().slice(0, 400),
      question: String(out.question || '').trim().slice(0, 300),
    };
  } finally {
    busy.delete(key);
  }
}

// ── talking to the user about it ────────────────────────────────────────

/**
 * Re-voice a message in the language and style this user actually writes in
 * (Roman Urdu, English, Arabic…). Falls back to the original on any failure.
 */
async function localize(user, text) {
  try {
    const history = require('../db/conversations').historyForUser(user.id, 30)
      .filter((m) => m.role === 'user' && m.content && !/^\[/.test(m.content))
      .slice(-6)
      .map((m) => `- ${String(m.content).slice(0, 160)}`);
    if (history.length < 2) return text;
    const out = await claude.complete(
      `Recent messages this person wrote:\n${history.join('\n')}\n\n`
      + 'Translate the MESSAGE below into the language they write in (e.g. Roman Urdu in Latin script stays Roman Urdu; English stays English). '
      + 'Translate the MEANING faithfully, sentence by sentence — do not add, drop or change any claim, and never turn "I am starting to…" into "I have done…". '
      + 'Use simple, natural, polite wording (in Urdu use "aap"/"tum", not "tu"). Keep names, numbers, bullets and line breaks. '
      + 'If they write in English, return the message unchanged. Output only the message.\n\n'
      + `MESSAGE:\n${text}`,
      { model: config.anthropic.model, maxTokens: 700 },
    );
    const cleaned = String(out || '').trim();
    return cleaned.length > 20 ? cleaned : text;
  } catch (_) {
    return text;
  }
}

async function tell(user, text, logLabel) {
  try {
    if (!user || !user.phone || !wa().ready()) return;
    await wa().sendProactiveMessage(user, await localize(user, text), { logLabel });
  } catch (e) {
    console.warn(`[study] message (${logLabel}) failed:`, e.message);
  }
}

function list(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function timelineText(user, apps) {
  const names = list(apps.map(appName));
  const it = apps.length > 1 ? 'them' : 'it';
  return `Your ${names} ${apps.length > 1 ? 'are' : 'is'} connected ✅ I am now starting to study ${it}, so that I really understand ${it}.\n\n`
    + `• In a few minutes: a first look — what is there and what matters.\n`
    + `• Within 24 hours: the patterns — who and what is important to you.\n`
    + `• Within 7 days: the full picture. After that I update it every week.\n\n`
    + `You can keep using me as normal. I only keep my own short summary, not a copy of your data.`;
}

function firstLookText(results) {
  const lines = results.map((r) => `• ${appName(r.app)}: ${r.summary || 'had a first look.'}`);
  const q = (results.find((r) => r.question) || {}).question;
  return `First look done ✅\n\n${lines.join('\n')}${q ? `\n\n${q}` : ''}`;
}

function fullPictureText(result) {
  return `I've now got the full picture of your ${appName(result.app)} ✅\n\n${result.summary || ''}\n\nI'll keep it fresh every week. If I've got anything wrong, just tell me.`.replace(/\n\n\n+/g, '\n\n');
}

// ── entry points ────────────────────────────────────────────────────────

/** Queue work so only one study runs at a time across the whole server. */
function enqueue(fn) {
  chain = chain.then(fn).catch((e) => console.warn('[study] queue error:', e.message));
  return chain;
}

/**
 * Study a set of apps we have not studied before.
 * `announce` lists the ones the user connected THEMSELVES just now — only those
 * get the timeline message and the "first look" summary. Apps that were already
 * connected before (or that we merely discovered) are studied quietly: a message
 * about an app the user did not just touch is noise.
 */
function startBatch(user, apps, announce = []) {
  if (!apps.length) return;
  const loud = apps.filter((a) => announce.includes(a));
  enqueue(async () => {
    const fresh = usersRepo.getById(user.id);
    if (!fresh) return;
    if (loud.length) await tell(fresh, timelineText(fresh, loud), 'study-timeline');
    const results = [];
    for (const app of apps) {
      const r = await studyApp(fresh.id, app);
      if (r.ok && loud.includes(app)) results.push(r);
    }
    if (results.length) await tell(usersRepo.getById(user.id) || fresh, firstLookText(results), 'study-first-look');
  });
}

// A connection this recent means the user just did it (and is expecting a reply).
const JUST_CONNECTED_MS = 20 * 60 * 1000;

function isJustConnected(connectedAt) {
  const ms = Date.parse(connectedAt || '');
  return !!ms && Date.now() - ms < JUST_CONNECTED_MS && Date.now() - ms > -60000;
}

/**
 * Called whenever we learn which Composio apps a user currently has connected:
 * [{ app, connectedAt }]. New apps get studied; apps that are gone are forgotten.
 */
function noticeConnections(user, connections) {
  if (!enabled() || !user || !user.id) return;
  const conns = (connections || []).map((c) => (typeof c === 'string' ? { app: c } : c))
    .map((c) => ({ app: String(c.app || '').toLowerCase(), connectedAt: c.connectedAt || null }))
    .filter((c) => c.app);
  const now = new Set(conns.map((c) => c.app));
  for (const row of knowledge.listForUser(user.id)) {
    if (!BUILTIN.has(row.app) && !now.has(row.app)) knowledge.remove(user.id, row.app);
  }
  const fresh = [];
  const announce = [];
  for (const c of conns) {
    const loud = isJustConnected(c.connectedAt);
    if (knowledge.ensure(user.id, c.app, { announced: loud })) {
      fresh.push(c.app);
      if (loud) announce.push(c.app);
    }
  }
  if (fresh.length) startBatch(user, fresh, announce);
}

/**
 * Built-in sources (Shopify): start studying if connected and not yet known.
 * `justConnected` is true only from the OAuth callback — i.e. the user did it now.
 */
function noticeBuiltins(user, { justConnected = false } = {}) {
  if (!enabled() || !user || !user.id) return;
  if (user.shopify_domain && user.shopify_token) {
    if (knowledge.ensure(user.id, 'shopify', { announced: justConnected })) {
      startBatch(user, ['shopify'], justConnected ? ['shopify'] : []);
    }
  } else if (knowledge.get(user.id, 'shopify')) {
    knowledge.remove(user.id, 'shopify');
  }
}

/** Scheduler tick: run the studies that are due (deepening passes + weekly refresh). */
async function runDue({ now = new Date(), limit = 4 } = {}) {
  if (!enabled()) return { studied: 0 };
  try { for (const u of usersRepo.listOnboarded()) noticeBuiltins(u); } catch (_) { /* best-effort */ }

  let studied = 0;
  for (const row of knowledge.due(limit)) {
    if (row.runs === 0 && busy.has(`${row.user_id}:${row.app}`)) continue; // its first batch is in flight
    const user = usersRepo.getById(row.user_id);
    if (!user) { knowledge.remove(row.user_id, row.app); continue; }
    await enqueue(async () => {
      const r = await studyApp(user.id, row.app);
      if (!r.ok) return;
      studied += 1;
      // Say so only the moment the picture becomes full, only in waking hours, and
      // only for an app the user connected themselves (never for a quiet study).
      if (r.full && r.runs === FULL_AFTER_RUNS && row.announced) {
        const hour = t.hourInTz(user.timezone || 'Asia/Karachi', now);
        if (hour >= ACTIVE_FROM && hour < ACTIVE_TO) await tell(user, fullPictureText(r), 'study-full');
      }
    });
  }
  return { studied };
}

/** "Study it again now" — used by the restudy tool. */
function restudy(user, app) {
  const slug = String(app || '').toLowerCase();
  if (!knowledge.get(user.id, slug)) knowledge.ensure(user.id, slug);
  enqueue(() => studyApp(user.id, slug));
  return { queued: true, app: appName(slug) };
}

// ── what goes into every chat ───────────────────────────────────────────

function stage(row) {
  if (!row.note) return row.status === 'failed' ? 'could not study it yet' : 'just connected — not studied yet';
  if (row.status === 'ready') return `full picture, last refreshed ${agoText(row.studied_at)}`;
  return `still learning (pass ${row.runs} of ${FULL_AFTER_RUNS}, last ${agoText(row.studied_at)})`;
}

/**
 * System-prompt block: Wingman's own notes about every connected app, plus the
 * overall profile the onboarding analyzer built from Gmail/Calendar/Tasks.
 */
function knowledgeBlock(user) {
  try {
    if (!user) return '';
    const rows = knowledge.listForUser(user.id);
    // The profile card (services/userProfile) is the distilled picture of the
    // whole person; fall back to the raw onboarding profile until it exists.
    let cardText = '';
    try { cardText = require('./userProfile').card(user); } catch (_) { /* optional */ }
    const profile = String((user.preferences && user.preferences.onboarding && user.preferences.onboarding.profile) || '').trim();
    if (!rows.length && !profile && !cardText) return '';

    const parts = [];
    if (cardText) parts.push(`OPERATING MANUAL (how to run things for them — built from everything you've seen):\n${cardText.slice(0, 3200)}\nWork from this like their chief of staff: rank by their PRIORITIES, treat KEY PEOPLE as tiered, handle what you can handle for them, and bring them decisions — not homework.`);
    else if (profile) parts.push(`OVERALL (from their email, calendar and tasks):\n${profile.slice(0, 900)}`);
    for (const r of rows.slice(0, 10)) {
      parts.push(`${appName(r.app).toUpperCase()} — ${stage(r)}${r.note ? `\n${String(r.note).slice(0, 1600)}` : ''}`);
    }
    return `\n\n--- WHAT YOU UNDERSTAND ABOUT THEIR WORLD ---\nYour own notes from studying what they connected. Use them to answer and act like someone who knows their business and life — don't ask what these already tell you.\n\n${parts.join('\n\n')}\n\nHow to use this:\n- These are summaries and can be days old. For live facts (today's sales, the latest message, current stock) call the app's tools — never quote a number from here as current.\n- Where it says you are still learning or have not studied an app yet, be honest about that if it matters ("I'm still getting to know your Shopify — give me a day"), then still do your best with the tools.\n- If they ask what you've learned about an app, tell them from here in plain words. If they say something here is wrong, correct yourself and call remember_fact.`;
  } catch (_) {
    return '';
  }
}

module.exports = {
  enabled, noticeConnections, noticeBuiltins, runDue, restudy, studyApp, knowledgeBlock,
  timelineText, firstLookText, // exported for tests
};
