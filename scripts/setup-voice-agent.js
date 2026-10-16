'use strict';
/**
 * Create (or update) Wingman's ElevenLabs voice agent for briefing calls.
 *
 *   docker exec wingman node scripts/setup-voice-agent.js
 *
 * Needs ELEVENLABS_API_KEY and PUBLIC_BASE_URL in .env. Creates the
 * "ask_wingman" webhook tool + the agent, and prints ELEVENLABS_AGENT_ID to add
 * to .env. Run it again any time to push prompt/voice changes to the same agent
 * (it updates the agent named in ELEVENLABS_AGENT_ID instead of creating one).
 */
const config = require('../src/config');
const el = require('../src/services/elevenlabs');
const briefingCall = require('../src/services/briefingCall');

const LLM = process.env.ELEVENLABS_AGENT_LLM || 'claude-sonnet-4-5';

const PROMPT = `You are Wingman, {{user_name}}'s AI chief of staff — calm, warm, sharp, a little witty, like a trusted human assistant (think JARVIS, not a call-centre bot). You are on a WhatsApp voice call with them. {{call_purpose}} Their local time now: {{local_time}}.

Today's {{briefing_kind}} (your notes — never read it out word for word; may be empty):
<briefing>
{{briefing}}
</briefing>

What Wingman (you) already knows about them — your memory; use it naturally, never recite it:
<memory>
{{brain}}
</memory>

How to run the call
- If you placed the call for a briefing: open, then give the highlights in a natural spoken way: what matters most first (meetings and their times, urgent emails or people waiting on them, bills due, tasks due, anything unusual). Skip empty sections. Round numbers, say times naturally, never read ids, links, emails addresses letter by letter, or long lists — summarise ("three meetings, the first at ten with Sara").
- Keep each turn short: two or three sentences, then let them react. Ask if they want detail on something rather than dumping everything.
- SPEED MATTERS. If the answer is in your notes or memory above (meetings, tasks, emails, bills, follow-ups, people, what they told you before), answer straight away — don't say you'll check, don't call any tool.
- They can ask you ANYTHING — about their day, inbox, calendar, tasks, store, health, people, or general questions. Only when the answer is NOT in your notes, needs fresh data, or they want you to do something, call the ask_wingman tool with their request in their own words (add the detail from the call that it needs). Speak its answer naturally. Never make anything up.
- NEVER GO QUIET — talk like a human assistant, not a machine that freezes. Before a lookup, say one short natural line that keeps them engaged, not just "let me pull it" — e.g. "Haan, aapke Facebook pages nikal raha hoon — aaj kisi page pe post karna hai ya insights dekhni hain?" A lookup answers within ~3 seconds or comes back "working". If ask_wingman comes back with status "working", the lookup is still running in the background: keep the conversation going — ask ONE useful related question that helps (flights → which date, morning or evening, airline preference, where they're staying; hotels → which area, budget; a meeting → who's joining), or mention something relevant from your notes. After they reply, call wingman_result to get the answer. If it's still working, keep chatting naturally and try again after the next exchange. Never say "please hold" or "processing". If they add details (e.g. the area of the city), call ask_wingman again with the fuller request.
- If the call is ending while something is still being looked up, tell them you'll send it on WhatsApp — Wingman does that automatically.
- Actions like sending an email, posting, cancelling or deleting: ask_wingman gets them ready; tell the user it's ready and they can confirm with a "yes" on WhatsApp. Do not claim it's done.
- Stay on as long as they want to talk. Never rush them off.
- When they're done (bye, thanks that's all, khuda hafiz, etc.), say a short warm goodbye and use the end_call tool. If they're busy or can't talk, say you'll leave it on WhatsApp, and end the call.
- Language: match how they speak. If they speak Urdu or Hindi or mix it with English, reply in natural everyday Urdu-English mix (the way people in Pakistan talk), never formal or Sanskrit-heavy Hindi. Otherwise speak English.`;

function askToolBody(url, secret) {
  return {
    tool_config: {
      type: 'webhook',
      name: 'ask_wingman',
      description: "Ask Wingman's brain anything the user wants during the call: fresh details about their emails, calendar, tasks, bills, deliveries, store, health, people or the web (flights, hotels, news…), or to prepare an action (email, post, event). Returns { answer } to speak — or, for a longer lookup, { status: 'working', job_id }: keep talking and fetch it with wingman_result.",
      response_timeout_secs: 20,
      pre_tool_speech: 'force',
      // Soft typing sound after the agent's one-liner, so the line never feels dead.
      tool_call_sound: 'typing',
      tool_call_sound_behavior: 'auto',
      api_schema: {
        url,
        method: 'POST',
        request_headers: { 'X-Wingman-Tool-Secret': secret },
        request_body_schema: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', description: "The user's question or request in their own words, plus any detail from the call it needs." },
            context: { type: 'string', description: 'One or two sentences on what was being discussed just before, if it helps.' },
            call_token: { type: 'string', dynamic_variable: 'call_token' },
          },
        },
      },
    },
  };
}

function resultToolBody(url, secret) {
  return {
    tool_config: {
      type: 'webhook',
      name: 'wingman_result',
      description: "Get the answer to a lookup that ask_wingman said is still 'working'. Call it after the user's next reply. Returns { answer } — or { status: 'working' } again, then keep chatting and retry after another exchange.",
      response_timeout_secs: 10,
      pre_tool_speech: 'off',
      tool_call_sound: 'typing',
      tool_call_sound_behavior: 'always',
      api_schema: {
        url,
        method: 'POST',
        request_headers: { 'X-Wingman-Tool-Secret': secret },
        request_body_schema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'The job_id ask_wingman returned. Leave empty for the latest lookup.' },
            call_token: { type: 'string', dynamic_variable: 'call_token' },
          },
        },
      },
    },
  };
}

/** Create the webhook tool, or update it in place if one with that name exists. */
async function upsertTool(body) {
  const name = body.tool_config.name;
  try {
    const list = await el.call('GET', '/v1/convai/tools');
    const found = (list.tools || []).find((t) => t.tool_config && t.tool_config.name === name);
    if (found) {
      await el.call('PATCH', `/v1/convai/tools/${encodeURIComponent(found.id)}`, body);
      return found.id;
    }
  } catch (e) {
    console.warn(`(could not reuse existing ${name} tool, creating a new one)`, e.message.slice(0, 120));
  }
  const tool = await el.call('POST', '/v1/convai/tools', body);
  return tool.id || tool.tool_id;
}

function agentBody(toolIds, { withHindi = true } = {}) {
  return {
    name: 'Wingman — briefing calls',
    tags: ['wingman'],
    conversation_config: {
      agent: {
        // No variables here: if the start-of-call data ever fails to load, the call
        // must still connect (each call overrides this greeting anyway).
        first_message: "Hi, it's Wingman. How can I help?",
        language: 'en',
        dynamic_variables: {
          dynamic_variable_placeholders: {
            user_name: 'there', briefing_kind: 'morning briefing', call_purpose: '', briefing: '', brain: '', local_time: '', call_token: '',
          },
        },
        prompt: {
          prompt: PROMPT,
          llm: LLM,
          temperature: 0.5,
          tool_ids: toolIds,
          built_in_tools: {
            end_call: { name: 'end_call', description: 'End the call when the user is done or busy.', params: { system_tool_type: 'end_call' } },
          },
        },
      },
      // English agents must use an English v2 model; adding Hindi (used for
      // Urdu speakers, set per call) makes ElevenLabs use v2.5 for that language.
      tts: { model_id: process.env.ELEVENLABS_AGENT_TTS_MODEL || 'eleven_flash_v2', voice_id: config.elevenlabs.voiceId },
      ...(withHindi ? { language_presets: { hi: { overrides: {} } } } : {}),
      conversation: { max_duration_seconds: 1800 },
    },
    platform_settings: {
      overrides: { conversation_config_override: { agent: { first_message: true, language: true } } },
    },
  };
}

(async () => {
  if (!config.elevenlabs.apiKey) throw new Error('Set ELEVENLABS_API_KEY in .env first.');
  const base = String(config.publicBaseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error(`PUBLIC_BASE_URL must be the public https URL (now: "${base}").`);
  const secret = briefingCall.toolSecret();
  const askId = await upsertTool(askToolBody(`${base}/voice/tools/ask`, secret));
  const resultId = await upsertTool(resultToolBody(`${base}/voice/tools/result`, secret));
  console.log('ask_wingman tool:', askId, '· wingman_result tool:', resultId);
  const toolIds = [askId, resultId];

  // Try with Urdu/Hindi support first; if the account rejects it, English only.
  const save = async (withHindi) => {
    const b = agentBody(toolIds, { withHindi });
    if (config.elevenlabs.agentId) {
      await el.call('PATCH', `/v1/convai/agents/${encodeURIComponent(config.elevenlabs.agentId)}`, b);
      return config.elevenlabs.agentId;
    }
    return (await el.call('POST', '/v1/convai/agents/create', b)).agent_id;
  };
  let agentId;
  try {
    agentId = await save(true);
  } catch (e) {
    if (!/language/i.test(e.message)) throw e;
    console.warn('Urdu/Hindi preset not accepted — creating an English-only agent.', e.message.slice(0, 160));
    agentId = await save(false);
  }
  console.log(config.elevenlabs.agentId ? 'Updated agent' : 'Created agent', agentId);
  if (!config.elevenlabs.agentId) console.log(`\nAdd to .env:\nELEVENLABS_AGENT_ID=${agentId}`);
  console.log(`\nFor calls the user makes TO Wingman (ElevenLabs → Agents settings → conversation initiation webhook):\n  URL:    ${base}/voice/inbound?key=${briefingCall.toolSecret()}\n  (no header or secret needed — the key is in the URL)`);
})().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
