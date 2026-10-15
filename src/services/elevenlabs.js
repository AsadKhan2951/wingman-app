'use strict';

/**
 * ElevenLabs REST client — only what Wingman uses:
 *   - speak(text)                     → a WhatsApp voice note (Ogg/Opus)
 *   - startWhatsAppCall(...)          → the agent calls the user on WhatsApp
 *   - getConversation(id)             → how that call went
 * Never logs the API key. Errors are thrown as Error('ELEVENLABS_<status>: …').
 */

const config = require('../config');

function key() {
  const k = config.elevenlabs.apiKey;
  if (!k) throw new Error('ELEVENLABS_NOT_CONFIGURED');
  return k;
}

function url(path) {
  return `${String(config.elevenlabs.baseUrl).replace(/\/+$/, '')}${path}`;
}

async function call(method, path, body, { raw = false } = {}) {
  const res = await fetch(url(path), {
    method,
    headers: {
      'xi-api-key': key(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 400); } catch (_) { /* not json */ }
    throw new Error(`ELEVENLABS_${res.status}${detail ? `: ${detail}` : ''}`);
  }
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Strip what sounds wrong read aloud: emoji, markdown, raw links. */
function forSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, 'the link in the chat')
    .replace(/[*_~`#>]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s*[•·\-–]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '.\n')
    .trim();
}

/**
 * Text → WhatsApp voice note. Asks for Ogg/Opus (what WhatsApp plays as a
 * voice note); if the response isn't Ogg, falls back to MP3, which WhatsApp
 * still delivers as an audio message.
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function speak(text, { voiceId = config.elevenlabs.voiceId, maxChars = 2500 } = {}) {
  const spoken = forSpeech(text).slice(0, maxChars);
  if (!spoken) throw new Error('ELEVENLABS_EMPTY_TEXT');
  const body = { text: spoken, model_id: config.elevenlabs.ttsModel };
  const path = (fmt) => `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${fmt}`;

  const res = await call('POST', path('opus_48000_64'), body, { raw: true });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 4 && buffer.slice(0, 4).toString('ascii') === 'OggS') {
    return { buffer, mimeType: 'audio/ogg' };
  }
  const mp3 = await call('POST', path('mp3_44100_128'), body, { raw: true });
  return { buffer: Buffer.from(await mp3.arrayBuffer()), mimeType: 'audio/mpeg' };
}

/**
 * Speech → text (ElevenLabs Scribe). Language is auto-detected, so English,
 * Urdu and mixed speech all work.
 * @returns {Promise<{text: string, language: string|null}>}
 */
async function transcribe(audio, { filename = 'voice.ogg', languageCode = null } = {}) {
  const form = new FormData();
  form.append('model_id', config.elevenlabs.sttModel);
  form.append('file', new Blob([audio]), filename);
  form.append('tag_audio_events', 'false');
  if (languageCode) form.append('language_code', languageCode);
  const res = await fetch(url('/v1/speech-to-text'), {
    method: 'POST',
    headers: { 'xi-api-key': key() },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = JSON.stringify(data).slice(0, 300);
    if (res.status === 401) throw new Error('VOICE_BAD_KEY');
    if (res.status === 402 || /quota|credit/i.test(detail)) throw new Error('VOICE_NO_CREDIT');
    throw new Error(`ELEVENLABS_${res.status}: ${detail}`);
  }
  return { text: String(data.text || '').trim(), language: data.language_code || null };
}

/**
 * Ask the Wingman agent to call a user on WhatsApp. If the user hasn't given
 * call permission yet, ElevenLabs first sends the permission template and calls
 * as soon as they allow it.
 * @returns {Promise<{conversationId: string|null, message: string}>}
 */
async function startWhatsAppCall({ waUserId, dynamicVariables = {}, language = null, firstMessage = null }) {
  const cfg = config.elevenlabs;
  if (!cfg.agentId) throw new Error('ELEVENLABS_AGENT_ID_MISSING');
  if (!cfg.callPhoneNumberId) throw new Error('ELEVENLABS_CALL_NUMBER_MISSING');
  const override = {};
  if (language || firstMessage) {
    override.agent = {};
    if (language) override.agent.language = language;
    if (firstMessage) override.agent.first_message = firstMessage;
  }
  const r = await call('POST', '/v1/convai/whatsapp/outbound-call', {
    agent_id: cfg.agentId,
    whatsapp_phone_number_id: cfg.callPhoneNumberId,
    whatsapp_user_id: String(waUserId).replace(/\D/g, ''),
    whatsapp_call_permission_request_template_name: cfg.callPermissionTemplate,
    whatsapp_call_permission_request_template_language_code: cfg.callPermissionTemplateLang,
    conversation_initiation_client_data: {
      dynamic_variables: dynamicVariables,
      ...(Object.keys(override).length ? { conversation_config_override: override } : {}),
    },
  });
  if (r && r.success === false) throw new Error(`ELEVENLABS_CALL_REFUSED: ${r.message || ''}`);
  return { conversationId: (r && r.conversation_id) || null, message: (r && r.message) || '' };
}

/**
 * Ask the Wingman agent to ring the user's normal phone number (Twilio number
 * imported into ElevenLabs). No WhatsApp permission needed.
 * @returns {Promise<{conversationId: string|null, message: string}>}
 */
async function startPhoneCall({ toNumber, dynamicVariables = {}, language = null, firstMessage = null }) {
  const cfg = config.elevenlabs;
  if (!cfg.agentId) throw new Error('ELEVENLABS_AGENT_ID_MISSING');
  if (!cfg.phoneNumberId) throw new Error('ELEVENLABS_PHONE_NUMBER_MISSING');
  const digits = String(toNumber || '').replace(/\D/g, '');
  if (!digits) throw new Error('NO_PHONE_NUMBER');
  const override = {};
  if (language || firstMessage) {
    override.agent = {};
    if (language) override.agent.language = language;
    if (firstMessage) override.agent.first_message = firstMessage;
  }
  const r = await call('POST', '/v1/convai/twilio/outbound-call', {
    agent_id: cfg.agentId,
    agent_phone_number_id: cfg.phoneNumberId,
    to_number: `+${digits}`,
    conversation_initiation_client_data: {
      dynamic_variables: dynamicVariables,
      ...(Object.keys(override).length ? { conversation_config_override: override } : {}),
    },
    telephony_call_config: { ringing_timeout_secs: cfg.ringSeconds },
  });
  if (r && r.success === false) throw new Error(`ELEVENLABS_CALL_REFUSED: ${r.message || ''}`);
  return { conversationId: (r && r.conversation_id) || null, message: (r && r.message) || '' };
}

/** Status + metadata + transcript of one conversation (call). */
async function getConversation(conversationId) {
  return call('GET', `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
}

module.exports = { speak, transcribe, startWhatsAppCall, startPhoneCall, getConversation, forSpeech, call };
