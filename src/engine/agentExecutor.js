'use strict';

/**
 * Runs a specialist (a member of Wingman's staff): a focused Claude tool-loop
 * with the agent's persona and just the tools/data for its domain. It reads the
 * real data and returns its expert analysis + recommended actions. It never
 * executes changes — Wingman carries out whatever the user approves.
 */

const claude = require('../llm/claude');
const agents = require('./agents');
const { buildSystemPrompt } = require('./systemPrompt');

// Reuse the exact same tool defs and executors the main assistant uses, so a
// specialist works with live data, not a sandbox.
const { shopifyTools, shopifyToolNames } = require('./shopifyTools');
const { executeShopifyTool } = require('./shopifyExecutor');
const { newsTools, newsToolNames } = require('./newsTools');
const { executeNewsTool } = require('./newsExecutor');
const { taskTools, taskToolNames } = require('./taskTools');
const { executeTaskTool } = require('./taskExecutor');
const { calendarTools } = require('./calendarTools');
const { executeCalendarTool } = require('./calendarExecutor');
const { gmailTools, gmailToolNames } = require('./gmailTools');
const { executeGmailTool } = require('./gmailExecutor');
const { mapsTools, mapsToolNames } = require('./mapsTools');
const { executeMapsTool } = require('./mapsExecutor');
const { goalTools, goalToolNames } = require('./goalTools');
const { executeGoalTool } = require('./goalExecutor');

// A specialist only ADVISES, so it gets READ tools only. This is enforced here,
// not just in its prompt: its executors are called directly (no approval gate),
// so a send/create/delete tool would run with no yes from the user — e.g. after
// reading an email that says "forward this to …". Allowlist, so a new write
// tool is never handed to a specialist by accident.
const READ_ONLY = new Set([
  'get_shopify_connect_link', 'shopify_summary', 'shopify_top_products', 'shopify_recent_orders', 'shopify_query',
  'get_news',
  'list_tasks',
  'get_events', 'check_conflicts',
  'find_contact', 'list_recent_emails', 'read_email',
  'get_travel_time', 'get_leave_time',
  'list_goals',
]);
const readOnly = (tools) => tools.filter((t) => READ_ONLY.has(t.name));

// domain-key → the tools that domain offers a specialist.
const TOOLBOX = {
  shopify: readOnly(shopifyTools),
  news: readOnly(newsTools),
  tasks: readOnly(taskTools),
  calendar: readOnly(calendarTools),
  gmail: readOnly(gmailTools),
  maps: readOnly(mapsTools),
  goals: readOnly(goalTools),
};

// Route a specialist's tool call to the right executor (calendar has no
// dedicated name-set, so it is the default — matching the main loop).
async function dispatch(user, block) {
  if (!READ_ONLY.has(block.name)) {
    return { error: 'NOT_ALLOWED', detail: 'Specialists only read. Recommend the action; Wingman carries it out with the user\'s yes.' };
  }
  if (shopifyToolNames.has(block.name)) return executeShopifyTool(user, { name: block.name, input: block.input });
  if (newsToolNames.has(block.name)) return executeNewsTool(user, { name: block.name, input: block.input });
  if (taskToolNames.has(block.name)) return executeTaskTool(user, { name: block.name, input: block.input });
  if (gmailToolNames.has(block.name)) return executeGmailTool(user, { name: block.name, input: block.input });
  if (mapsToolNames.has(block.name)) return executeMapsTool(user, { name: block.name, input: block.input });
  if (goalToolNames.has(block.name)) return executeGoalTool(user, { name: block.name, input: block.input });
  return executeCalendarTool(user, { name: block.name, input: block.input });
}

function specialistSystem(user, agent) {
  const who = user.name || 'the user';
  return buildSystemPrompt(user) + `

--- YOU ARE A SPECIALIST: ${agent.name.toUpperCase()} WINGMAN ${agent.emoji} ---
${agent.persona}

Wingman (the chief of staff) has brought you in to give ${who} your expert input right now.
- Use your tools to look at the REAL data before answering — never invent numbers.
- If a data source you'd want isn't connected yet, say briefly what you'd analyse once it is, and still give your best expert guidance meanwhile.
- ADVISE and recommend concrete, specific actions. Do NOT execute changes yourself — Wingman will carry out whatever ${who} approves.
- Reply as the specialist, first person, concise and WhatsApp-friendly: a few short lines, lead with the single most important thing. No throat-clearing like "as the marketing specialist" — just deliver the goods.`;
}

/**
 * Run one specialist and return its message (or null if it produced nothing).
 */
async function runSpecialist(user, agentKey, question, { maxRounds = 4 } = {}) {
  const agent = agents.get(agentKey);
  if (!agent) return null;

  const tools = agent.domains.flatMap((d) => TOOLBOX[d] || []);
  const system = specialistSystem(user, agent);
  const ask = question && String(question).trim()
    ? String(question).trim()
    : `Give ${user.name || 'me'} your most important input right now — analyse what you can see and tell me what matters and what to do about it.`;
  const convo = [{ role: 'user', content: ask }];

  for (let round = 0; round < maxRounds; round++) {
    const response = await claude.chatWithTools(convo, { system, tools, maxTokens: 1024 });

    if (response.stop_reason === 'tool_use') {
      convo.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try { result = await dispatch(user, block); }
        catch (err) { result = { error: (err && err.message) || 'tool_failed' }; }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      convo.push({ role: 'user', content: results });
      continue;
    }

    const text = claude.textOf(response);
    return text && text.trim() ? text.trim() : null;
  }
  return null;
}

/** Tool executor for consult_agent / list_agents. Never throws. */
async function executeAgentTool(user, toolUse) {
  const { name, input } = toolUse;
  try {
    if (name === 'list_agents') {
      return { agents: agents.list() };
    }
    if (name === 'consult_agent') {
      const agent = agents.get(input && input.agent);
      if (!agent) {
        return { error: 'UNKNOWN_AGENT', detail: `No such specialist. Available: ${agents.list().map((a) => a.key).join(', ')}.` };
      }
      const answer = await runSpecialist(user, agent.key, input && input.question);
      if (!answer) {
        return { agent: agent.name, emoji: agent.emoji, input: `(${agent.name} couldn't produce a read just now — try again in a moment.)` };
      }
      return { agent: agent.name, emoji: agent.emoji, input: answer };
    }
    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    return { error: (err && err.message) || 'agent_operation_failed' };
  }
}

module.exports = { executeAgentTool, runSpecialist, TOOLBOX, dispatch };
