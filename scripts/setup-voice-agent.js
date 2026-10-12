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

const PROMPT = `You are Wingman, {{user_name}}'s AI chief of staff — calm, warm, sharp, a little witty, like a trusted human assistant (think JARVIS, not a call-centre bot). You are on a WhatsApp voice call that YOU placed to deliver their {{briefing_kind}}. Their local time now: {{local_time}}.

Today's {{briefing_kind}} (your notes — never read it out word for word):
<briefing>
{{briefing}}
</briefing>

How to run the call
- Open, then give the highlights in a natural spoken way: what matters most first (meetings and their times, urgent emails or people waiting on them, bills due, tasks due, anything unusual). Skip empty sections. Round numbers, say times naturally, never read ids, links, emails addresses letter by letter, or long lists — summarise ("three meetings, the first at ten with Sara").
- Keep each turn short: two or three sentences, then let them react. Ask if they want detail on something rather than dumping everything.
- They can ask you ANYTHING — about their day, inbox, calendar, tasks, store, health, people, or general questions. If the answer is not clearly in the briefing above, or needs fresh data, or they want you to do something, call the ask_wingman tool with their request in their own words (add the detail from the call that it needs). Say a short natural filler first ("one sec, let me check"). Speak its answer naturally. Never make anything up.
- Actions like sending an email, posting, cancelling or deleting: ask_wingman gets them ready; tell the user it's ready and they can confirm with a "yes" on WhatsApp. Do not claim it's done.
- Stay on as long as they want to talk. Never rush them off.
- When they're done (bye, thanks that's all, khuda hafiz, etc.), say a short warm goodbye and use the end_call tool. If they're busy or can't talk, say you'll leave it on WhatsApp, and end the call.
- Language: match how they speak. If they speak Urdu or Hindi or mix it with English, reply in natural everyday Urdu-English mix (the way people in Pakistan talk), never formal or Sanskrit-heavy Hindi. Otherwise speak English.`;

function toolBody(url, secret) {
  return {
    tool_config: {
      type: 'webhook',
      name: 'ask_wingman',
      description: "Ask Wingman's brain anything the user wants during the call: fresh details about their emails, calendar, tasks, bills, deliveries, store, health, people or the web, or to prepare an action (email, post, event). Returns a short answer to speak.",
      response_timeout_secs: 60,
      pre_tool_speech: 'force',
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

function agentBody(toolId, { withHindi = true } = {}) {
  return {
    name: 'Wingman — briefing calls',
    tags: ['wingman'],
    conversation_config: {
      agent: {
        first_message: "Hi {{user_name}}, it's Wingman with your {{briefing_kind}}. Shall I go through it?",
        language: 'en',
        dynamic_variables: {
          dynamic_variable_placeholders: {
            user_name: 'there', briefing_kind: 'morning briefing', briefing: '', local_time: '', call_token: '',
          },
        },
        prompt: {
          prompt: PROMPT,
          llm: LLM,
          temperature: 0.5,
          tool_ids: [toolId],
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
  const url = `${base}/voice/tools/ask`;

  // Reuse the ask_wingman tool if it already exists (re-runs shouldn't pile up copies).
  const body = toolBody(url, briefingCall.toolSecret());
  let toolId = null;
  try {
    const list = await el.call('GET', '/v1/convai/tools');
    const found = (list.tools || []).find((t) => t.tool_config && t.tool_config.name === 'ask_wingman');
    if (found) {
      toolId = found.id;
      await el.call('PATCH', `/v1/convai/tools/${encodeURIComponent(toolId)}`, body);
    }
  } catch (e) {
    console.warn('(could not reuse existing tool, creating a new one)', e.message.slice(0, 120));
    toolId = null;
  }
  if (!toolId) {
    const tool = await el.call('POST', '/v1/convai/tools', body);
    toolId = tool.id || tool.tool_id;
  }
  console.log('ask_wingman tool:', toolId);

  // Try with Urdu/Hindi support first; if the account rejects it, English only.
  const save = async (withHindi) => {
    const b = agentBody(toolId, { withHindi });
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
  console.log(`\nAdd to .env:\nELEVENLABS_AGENT_ID=${agentId}`);
})().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
