'use strict';

const usersRepo = require('../db/users');
const conversationsRepo = require('../db/conversations');
const claude = require('../llm/claude');
const { buildSystemPrompt, buildSystemPromptParts } = require('./systemPrompt');
const { calendarTools } = require('./calendarTools');
const { executeCalendarTool } = require('./calendarExecutor');
const { taskTools, taskToolNames } = require('./taskTools');
const { executeTaskTool } = require('./taskExecutor');
const { goalTools, goalToolNames } = require('./goalTools');
const { executeGoalTool } = require('./goalExecutor');
const { auditTools, auditToolNames } = require('./auditTools');
const { executeAuditTool } = require('./auditExecutor');
const { vaultTools, vaultToolNames } = require('./vaultTools');
const { executeVaultTool } = require('./vaultExecutor');
const { browserTools, browserToolNames } = require('./browserTools');
const { executeBrowserTool } = require('./browserExecutor');
const { gmailTools, gmailToolNames } = require('./gmailTools');
const { executeGmailTool } = require('./gmailExecutor');
const { driveTools, driveToolNames } = require('./driveTools');
const { executeDriveTool } = require('./driveExecutor');
const { shopifyTools, shopifyToolNames } = require('./shopifyTools');
const { newsTools, newsToolNames } = require('./newsTools');
const { memoryTools, memoryToolNames } = require('./memoryTools');
const { mapsTools, mapsToolNames } = require('./mapsTools');
const { rideTools, rideToolNames } = require('./rideTools');
const { webmailTools, webmailToolNames } = require('./webmailTools');
const { voiceTools, voiceToolNames } = require('./voiceTools');
const { healthTools, healthToolNames } = require('./healthTools');
const { executeHealthTool } = require('./healthExecutor');
const { workTools, workToolNames } = require('./workTools');
const { executeWorkTool } = require('./workExecutor');
const { automationTools, automationToolNames } = require('./automationTools');
const { executeAutomationTool } = require('./automationExecutor');
const { agentTools, agentToolNames } = require('./agentTools');
const { executeAgentTool } = require('./agentExecutor');
const { executeVoiceTool } = require('./voiceExecutor');
const { executeWebmailTool } = require('./webmailExecutor');
const { executeMapsTool } = require('./mapsExecutor');
const { executeRideTool } = require('./rideExecutor');
const { executeMemoryTool } = require('./memoryExecutor');
const { executeNewsTool } = require('./newsExecutor');
const { executeShopifyTool } = require('./shopifyExecutor');
const { integrationToolsForUser } = require('./integrationTools');
const {
  executeIntegrationTool, pendingActionsBlock, gateBuiltin, setBuiltinRunner, BUILTIN_GATED,
} = require('./integrationExecutor');
const { imageToolNames, imageToolsAvailable } = require('./imageTools');
const { executeImageTool, recentImagesBlock } = require('./imageExecutor');
const { brainTools, brainToolNames } = require('./brainTools');
const { recordsTools, recordsToolNames } = require('./recordsTools');
const { followupTools, followupToolNames, executeFollowupTool } = require('./followupTools');
const { replyTools, replyToolNames, executeReplyTool } = require('./replyTools');
const { executeRecordsTool } = require('./recordsExecutor');
const { executeBrainTool, rulesBlock } = require('./brainExecutor');
const appStudy = require('../services/appStudy');
const config = require('../config');

/**
 * Handle an inbound WhatsApp message end-to-end.
 *
 * @param {Object} params
 * @param {string} params.text
 * @param {string} params.phoneNumber
 * @param {Object} [params.meta]
 * @returns {Promise<{reply:string, user:Object}>}
 */
async function handleMessage({ text, phoneNumber, meta = {} }) {
  let user = usersRepo.getByPhone(phoneNumber);

  if (!user || !usersRepo.isOnboarded(user)) {
    return {
      reply:
        "Hi! I'm Wingman, a personal AI assistant. I only chat with registered users. " +
        `Set up your account here to get started: ${config.publicBaseUrl} 🚀`,
      user: user || null,
      ignored: true,
    };
  }

  conversationsRepo.logMessage({
    userId: user.id,
    role: 'user',
    content: text,
    metadata: { direction: 'inbound', phoneNumber, ...meta },
  });

  // Every message goes to the assistant. There are deliberately NO keyword
  // shortcuts here any more: matching words like "link"+"drive" or "bills"+"any"
  // hijacked real requests ("…add it in the drive and send me the link") and
  // never worked in Roman Urdu. Bills, deliveries, trips, contacts, the inbox
  // digest and the Google connect link are all tools/context the assistant
  // chooses to use (engine/recordsTools.js, connectLinkBlock).
  const out = {};
  const reply = await runConversation(user, text, out);

  conversationsRepo.logMessage({
    userId: user.id,
    role: 'assistant',
    content: reply,
    metadata: {
      direction: 'outbound',
      phoneNumber,
      ...(meta && meta.source === 'app' ? { source: 'app' } : {}),
      ...(out.toolLog && out.toolLog.length ? { toolLog: out.toolLog } : {}),
    },
  });

  return { reply, user };
}

async function runOnboarding(user, text, isNew) {
  const prefs = user.preferences || {};
  const ob = prefs.onboarding || { step: 'ask_name', complete: false };

  if (isNew && ob.step === 'ask_name' && !ob.greeted) {
    ob.greeted = true;
    prefs.onboarding = ob;
    usersRepo.update(user.id, { preferences: prefs });
    return `Hey! I'm Wingman - your AI chief of staff. What should I call you? 🙌`;
  }

  switch (ob.step) {
    case 'ask_name': {
      const name = cleanName(text);
      ob.step = 'ask_timezone';
      prefs.onboarding = ob;
      usersRepo.update(user.id, { name, preferences: prefs });
      return `Nice to meet you, ${name.split(/\s+/)[0]}! 🌟\n\nWhat timezone are you in? (e.g. Asia/Karachi, Asia/Dubai)`;
    }

    case 'ask_timezone': {
      const tz = text.trim();
      ob.step = 'ask_hours';
      prefs.onboarding = ob;
      usersRepo.update(user.id, { timezone: tz, preferences: prefs });
      return `Got it - ${tz}. ⏰\n\nLast thing: what are your work hours? (e.g. 9am to 6pm)`;
    }

    case 'ask_hours': {
      const { start, end } = parseWorkHours(text);
      ob.step = 'complete';
      ob.complete = true;
      prefs.onboarding = ob;
      usersRepo.update(user.id, {
        work_hours_start: start,
        work_hours_end: end,
        preferences: prefs,
      });
      const firstName = (user.name || 'there').split(/\s+/)[0];
      return `Perfect, you're all set ${firstName}! ✅\n\nI'll keep an eye on your day and reach out when it matters. You can ask me to manage tasks, check bills, track deliveries, and more.\n\nTry me: "what can you do?" 🚀`;
    }

    default:
      ob.step = 'complete';
      ob.complete = true;
      prefs.onboarding = ob;
      usersRepo.update(user.id, { preferences: prefs });
      return runConversation(usersRepo.getById(user.id), text);
  }
}

/**
 * Give the assistant the user's real Google connect link, so it can hand it
 * over however they ask ("google connect karo", "mera drive jor do") or when a
 * Google tool says it isn't connected — instead of telling them to type a magic
 * phrase.
 */
function connectLinkBlock(user) {
  if (!user || !user.phone) return '';
  const url = `${config.publicBaseUrl}/auth/google?${require('../utils/linkSig').connectQuery(user.phone)}`;
  return `\n\n--- GOOGLE CONNECT LINK ---\nOne link connects Gmail, Calendar, Drive and Tasks together: ${url}\nSend it (just the link with one short line) when they ask to connect or reconnect any of those in any wording, or when a Google tool returns a NOT_CONNECTED / SCOPE_MISSING error. Never tell them to type a special phrase to get it. After they connect, carry on with what they originally asked.`;
}

// ─── What the assistant did in recent turns ─────────────────────────
// Chat history is stored as plain text, so the ids, numbers and results the
// tools returned last turn were lost by the next one ("which email? which
// event?"). Each turn now keeps a compact log of its tool calls, and the last
// few logs ride along in the system prompt.
const TOOL_LOG_MAX_ITEMS = 12;
const TOOL_LOG_ITEM_CHARS = 420;

function compactJson(v, n) {
  let t;
  try { t = JSON.stringify(v); } catch (_) { t = String(v); }
  t = String(t || '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function toolLogEntry(name, input, result) {
  if (name === 'find_app_tools') return `find_app_tools(${compactJson(input && input.app, 40)})`;
  return `${name}(${compactJson(input || {}, 160)}) → ${compactJson(result, TOOL_LOG_ITEM_CHARS)}`;
}

function recentToolContextBlock(user) {
  try {
    const rows = conversationsRepo.historyForUser(user.id, 12)
      .filter((r) => r.role === 'assistant')
      .slice(-3);
    const parts = [];
    for (const r of rows) {
      let meta = r.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = null; } }
      const log = meta && Array.isArray(meta.toolLog) ? meta.toolLog : null;
      if (!log || !log.length) continue;
      parts.push(`[${r.created_at} UTC]\n${log.map((l) => `- ${l}`).join('\n')}`);
    }
    if (!parts.length) return '';
    return `\n\n--- WHAT YOUR TOOLS RETURNED IN RECENT TURNS (for ids, numbers and results you already looked up; re-check with a tool if it may have changed) ---\n${parts.join('\n')}`;
  } catch (_) {
    return '';
  }
}

async function runConversation(user, text, out = {}) {
  const history = conversationsRepo.historyForUser(user.id, 20);
  const messages = history.map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content || '',
  }));

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: text });
  }

  // Start learning Shopify if it was connected before the study feature existed.
  try { appStudy.noticeBuiltins(user); } catch (_) { /* best-effort */ }
  // Two blocks: the big, unchanging guides are prompt-cached; everything that
  // changes from turn to turn comes after the cache breakpoint.
  const parts = buildSystemPromptParts(user);
  const system = [
    { type: 'text', text: parts.stable, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: parts.dynamic + connectLinkBlock(user) + require('../services/googleConnection').promptBlock(user) + appStudy.knowledgeBlock(user) + rulesBlock(user)
        + require('../services/meetingFollowup').promptBlock(user) + require('../services/replyDrafter').promptBlock(user) + pendingActionsBlock(user) + recentImagesBlock(user) + recentToolContextBlock(user),
    },
  ];
  const ctx = { toolLog: [] };
  const reply = await runToolLoop(user, messages, system, CHAT_MAX_ROUNDS, ctx);
  out.toolLog = ctx.toolLog;

  try {
    require('../services/behaviorLearner')
      .learnForUser(user.id)
      .catch((e) => console.warn('[behaviorLearner]', e.message));
    // Learn how they write (first time as soon as there's enough, then refresh).
    require('../services/styleProfile')
      .maybeBuild(require('../db/users').getById(user.id) || user)
      .catch((e) => console.warn('[styleProfile]', e.message));
  } catch (_) {
    // non-fatal
  }

  return reply;
}

/**
 * Execute a standing instruction (an automation) with the full tool set, in
 * isolation from the chat history — so an automated run neither depends on nor
 * pollutes the conversation. Returns the message to send the user, or null if
 * the AI decided nothing needed sending.
 */
async function runAutomatedInstruction(user, instruction) {
  const system = buildSystemPrompt(user) + rulesBlock(user) +
    `\n\n--- AUTOMATED RUN ---\nThis is a scheduled standing instruction you set up earlier, firing now — the user did NOT just message you. Carry it out with your tools and reply with ONLY the message to send them: the result itself (e.g. the traffic update), briefly and naturally, as if you proactively reached out. Do not ask questions or say "let me know" — just do it. If for some reason it genuinely cannot be done right now, reply with a short honest note about that instead.`;

  const messages = [{ role: 'user', content: `[Scheduled instruction firing now] ${instruction}` }];
  const reply = await runToolLoop(user, messages, system, 4, { automated: true });
  return (reply || '').trim() || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cheap checks so an action that can't work isn't parked for a yes first. */
function precheckBuiltin(user, name, input = {}) {
  if (['send_email', 'reply_to_email', 'forward_email'].includes(name)
      && !require('../auth/googleAuth').isEmailConnected(user)) return { error: 'EMAIL_NOT_CONNECTED' };
  if (['send_business_email', 'reply_business_email'].includes(name) && !user.webmail_address) {
    return { error: 'BUSINESS_EMAIL_NOT_CONNECTED' };
  }
  if (['send_email', 'forward_email', 'send_business_email'].includes(name)) {
    const to = String(input.to || '').trim();
    if (!EMAIL_RE.test(to)) {
      return { error: 'INVALID_RECIPIENT', detail: `"${to}" is not a valid email address. Use find_contact or ask the user for the address.` };
    }
  }
  return null;
}

/** Run a built-in tool for real (after the user's yes, or when it isn't gated). */
async function runBuiltinTool(user, name, input) {
  const fresh = usersRepo.getById(user.id) || user;
  const toolUse = { name, input: input || {} };
  if (gmailToolNames.has(name)) return executeGmailTool(fresh, toolUse);
  if (webmailToolNames.has(name)) return executeWebmailTool(fresh, toolUse);
  if (driveToolNames.has(name)) return executeDriveTool(fresh, toolUse);
  if (rideToolNames.has(name)) return executeRideTool(fresh, toolUse);
  return executeCalendarTool(fresh, toolUse);
}
setBuiltinRunner(runBuiltinTool);

/**
 * Answer a question the user asked during a briefing CALL (the ElevenLabs
 * agent forwards it here). Same brain, same tools, but an automated context:
 * nothing that sends/deletes/spends can be approved from a call — it is parked
 * and the user confirms on WhatsApp. The answer is meant to be spoken.
 */
async function answerForCall(user, question, { context = '' } = {}) {
  const system = buildSystemPrompt(user) + appStudy.knowledgeBlock(user) + rulesBlock(user) + recentToolContextBlock(user)
    + `\n\n--- LIVE VOICE CALL ---\nThe user is on a WhatsApp voice call with you right now (your briefing call) and asked the question below out loud. Use your tools to get the real answer. Reply with ONLY what should be SPOKEN: one to three short, natural sentences, in the language they used (Roman Urdu/Urdu → speak Urdu-English mix; English → English). No lists, no markdown, no emoji, no links, no ids. If they asked you to DO something that needs their yes (send, post, delete, cancel), call the tool so it is ready, then say it's ready and they can say yes on WhatsApp — you cannot approve it from the call.`
    + (context ? `\n\nWhat has been said on the call so far (for reference): ${String(context).slice(0, 1500)}` : '');
  const messages = [{ role: 'user', content: String(question || '').slice(0, 1000) }];
  const reply = await runToolLoop(user, messages, system, 5, { automated: true, toolLog: [] });
  return String(reply || '').replace(/[*_#`]/g, '').trim();
}

const CHAT_MAX_ROUNDS = 8;

/** Built-in tools, always in the same order (so they can be prompt-cached). */
function builtinToolList() {
  return [
    ...calendarTools,
    ...taskTools,
    ...goalTools,
    ...auditTools,
    ...vaultTools,
    ...browserTools,
    ...gmailTools,
    ...driveTools,
    ...shopifyTools,
    ...newsTools,
    ...memoryTools,
    ...mapsTools,
    ...rideTools,
    ...webmailTools,
    ...voiceTools,
    ...healthTools,
    ...workTools,
    ...automationTools,
    ...agentTools,
    ...imageToolsAvailable(),
    ...brainTools,
    ...recordsTools,
    ...followupTools,
    ...replyTools,
  ];
}

async function runToolLoop(user, messages, system, maxRounds = 5, ctx = {}) {
  const convo = [...messages];
  // Third-party app tools (Composio) for the apps THIS user has connected.
  // Built once per turn; never throws — an outage just means no app tools.
  let integrations;

  // Rounds spent only on find_app_tools (looking up / loading an app's tools)
  // don't eat into the real budget — up to 2 free rounds per turn.
  let freeRounds = 2;
  for (let round = 0; round < maxRounds; round++) {
    // Rebuilt each round (cached underneath) so tools loaded by find_app_tools
    // in one round are callable in the next.
    integrations = await integrationToolsForUser(user);
    const builtin = builtinToolList();
    const response = await claude.chatWithTools(convo, {
      system,
      cacheTools: builtin.length,
      tools: [...builtin, ...integrations.tools],
      maxTokens: 2048,
    });

    if (response.stop_reason === 'tool_use') {
      convo.push({ role: 'assistant', content: response.content });
      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (freeRounds > 0 && uses.length && uses.every((b) => b.name === 'find_app_tools')) { freeRounds--; maxRounds++; }

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let result;
        if (integrations.names.has(block.name)) {
          // Checked first: app tool names are Composio slugs, and anything not
          // matched below would otherwise fall through to the calendar executor.
          result = await executeIntegrationTool(user, { name: block.name, input: block.input }, ctx);
        } else if (rideToolNames.has(block.name) && !config.uber.enabled) {
          // No Uber business account yet → "link mode": Wingman prepares an
          // Uber link with pickup + drop filled in; the user books in their
          // own Uber app. Nothing is spent by Wingman, so no approval needed.
          result = await executeRideTool(user, { name: block.name, input: block.input });
        } else if (BUILTIN_GATED.has(block.name)) {
          // Outward-facing / hard-to-undo built-ins wait for the user's yes on
          // the server, exactly like app tools.
          result = precheckBuiltin(user, block.name, block.input)
            || await gateBuiltin(user, block.name, block.input, ctx, () => runBuiltinTool(user, block.name, block.input));
        } else if (imageToolNames.has(block.name)) {
          result = await executeImageTool(user, { name: block.name, input: block.input });
        } else if (brainToolNames.has(block.name)) {
          result = await executeBrainTool(user, { name: block.name, input: block.input }, ctx);
        } else if (recordsToolNames.has(block.name)) {
          result = await executeRecordsTool(user, { name: block.name, input: block.input });
        } else if (replyToolNames.has(block.name)) {
          result = await executeReplyTool(user, { name: block.name, input: block.input }, ctx);
        } else if (followupToolNames.has(block.name)) {
          result = await executeFollowupTool(user, { name: block.name, input: block.input }, ctx);
        } else if (taskToolNames.has(block.name)) {
          result = await executeTaskTool(user, { name: block.name, input: block.input });
        } else if (goalToolNames.has(block.name)) {
          result = await executeGoalTool(user, { name: block.name, input: block.input });
        } else if (auditToolNames.has(block.name)) {
          result = await executeAuditTool(user, { name: block.name, input: block.input });
        } else if (vaultToolNames.has(block.name)) {
          result = await executeVaultTool(user, { name: block.name, input: block.input });
        } else if (browserToolNames.has(block.name)) {
          result = await executeBrowserTool(user, { name: block.name, input: block.input });
        } else if (gmailToolNames.has(block.name)) {
          result = await executeGmailTool(user, { name: block.name, input: block.input });
        } else if (driveToolNames.has(block.name)) {
          result = await executeDriveTool(user, { name: block.name, input: block.input });
        } else if (shopifyToolNames.has(block.name)) {
          result = await executeShopifyTool(user, { name: block.name, input: block.input });
        } else if (newsToolNames.has(block.name)) {
          result = await executeNewsTool(user, { name: block.name, input: block.input });
        } else if (memoryToolNames.has(block.name)) {
          result = await executeMemoryTool(user, { name: block.name, input: block.input });
        } else if (mapsToolNames.has(block.name)) {
          result = await executeMapsTool(user, { name: block.name, input: block.input });
        } else if (rideToolNames.has(block.name)) {
          result = await executeRideTool(user, { name: block.name, input: block.input });
        } else if (webmailToolNames.has(block.name)) {
          result = await executeWebmailTool(user, { name: block.name, input: block.input });
        } else if (voiceToolNames.has(block.name)) {
          result = await executeVoiceTool(user, { name: block.name, input: block.input });
        } else if (healthToolNames.has(block.name)) {
          result = await executeHealthTool(user, { name: block.name, input: block.input });
        } else if (workToolNames.has(block.name)) {
          result = await executeWorkTool(user, { name: block.name, input: block.input });
        } else if (automationToolNames.has(block.name)) {
          result = await executeAutomationTool(user, { name: block.name, input: block.input });
        } else if (agentToolNames.has(block.name)) {
          result = await executeAgentTool(user, { name: block.name, input: block.input });
        } else {
          result = await executeCalendarTool(user, { name: block.name, input: block.input });
        }

        // Audit trail: record any action that actually changed something (best-effort).
        try { require('../db/agentActions').logToolAction(user.id, block.name, result); } catch (_) { /* never break the reply */ }
        if (Array.isArray(ctx.toolLog) && ctx.toolLog.length < TOOL_LOG_MAX_ITEMS) {
          ctx.toolLog.push(toolLogEntry(block.name, block.input, result));
        }
        if (result && result.error) ctx.hadErrors = true;

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      convo.push({ role: 'user', content: toolResults });
      continue;
    }

    const text = claude.textOf(response);
    if (text && text.trim()) return text;
    // A turn that ended with no words after tools: never claim success blindly.
    return ctx.hadErrors ? "I couldn't finish that — something failed on the way. Want me to try again?" : 'Done ✅';
  }

  // Out of rounds. This used to reply "I've handled that ✅" no matter what had
  // (or hadn't) happened. Now the model gets one last, tool-free turn to say
  // honestly what it finished and what is left.
  return finalWords(convo, system, integrations ? integrations.tools : []);
}

async function finalWords(convo, system, extraTools = []) {
  try {
    const last = convo[convo.length - 1];
    const note = {
      type: 'text',
      text: '[System: the tool budget for this message is used up — no more tools can run now. Reply to the user: say plainly what you actually completed (only what the tool results confirm) and what is still left, and offer to continue. Do not claim anything you did not do.]',
    };
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(note);
    else convo.push({ role: 'user', content: [note] });
    const response = await claude.chatWithTools(convo, {
      system,
      tools: [...builtinToolList(), ...extraTools],
      cacheTools: builtinToolList().length,
      toolChoice: { type: 'none' },
      maxTokens: 700,
    });
    const text = claude.textOf(response);
    if (text && text.trim()) return text;
  } catch (e) {
    console.warn('[conversation] final summary failed:', e.message);
  }
  return "I ran out of steps before finishing this one. Tell me to continue and I'll pick up where I left off.";
}

function cleanName(text) {
  let t = text.trim()
    .replace(/^(hi|hello|hey)[,!\s]+/i, '')
    .replace(/^(i'?m|i am|my name is|call me|it'?s)\s+/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!t) t = text.trim();
  return t.split(/\s+/).slice(0, 3).join(' ');
}

function parseWorkHours(text) {
  const t = text.toLowerCase();
  const times = [...t.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)];
  const to24 = (m) => {
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ? m[2] : '00';
    const mer = m[3];
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  };
  const start = times[0] ? to24(times[0]) : '09:00';
  const end = times[1] ? to24(times[1]) : '18:00';
  return { start: start || '09:00', end: end || '18:00' };
}

module.exports = {
  answerForCall,
  handleMessage,
  runConversation,
  runAutomatedInstruction,
};
