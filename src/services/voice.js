'use strict';

const config = require('../config');

/**
 * Voice for WhatsApp chat: the user's voice note → text, and Wingman's reply →
 * a voice note.
 *
 * ElevenLabs is the provider (Scribe for speech-to-text, multilingual TTS for
 * the reply). OpenAI Whisper/TTS is only a fallback for servers that have an
 * OPENAI_API_KEY but no ELEVENLABS_API_KEY.
 *
 * Users here mix Roman Urdu and English. Scribe auto-detects the language and
 * writes Urdu in Urdu script, so any non-Latin transcript is converted to Roman
 * Urdu (the script they actually type) before it reaches the assistant — that
 * keeps replies in Roman Urdu too.
 */

const OPENAI = 'https://api.openai.com/v1';

function useEleven() { return !!config.elevenlabs.apiKey; }
function useOpenAI() { return !useEleven() && !!config.voice.apiKey; }
function enabled() { return useEleven() || !!config.voice.apiKey; }

// ── Voices ──────────────────────────────────────────────────────────────
// Stock ElevenLabs voices every account has. `id` is what we store in
// users.voice_name; `eleven` is the ElevenLabs voice id.
// 'wingman' is Wingman's own voice (ELEVENLABS_VOICE_ID — the same voice the
// calls use) and is what everyone hears unless they pick another one.
const VOICE_OPTIONS = [
  { id: 'wingman', eleven: null, openai: 'fable', gender: 'male', label: "Wingman's voice (default)" },
  { id: 'george', eleven: 'JBFqnCBsd6RMkjVDRZzb', openai: 'fable', gender: 'male', label: 'Male — British, warm' },
  { id: 'daniel', eleven: 'onwK4e9ZLuTAKqWW03F9', openai: 'ballad', gender: 'male', label: 'Male — British, formal' },
  { id: 'brian', eleven: 'nPczCjzI2devNBz1zQrb', openai: 'onyx', gender: 'male', label: 'Male — deep' },
  { id: 'matilda', eleven: 'XrExE9yKIg1WjnStVfdQ', openai: 'nova', gender: 'female', label: 'Female — warm' },
  { id: 'sarah', eleven: 'EXAVITQu4vr4xnSDxMaL', openai: 'shimmer', gender: 'female', label: 'Female — soft' },
  { id: 'alice', eleven: 'Xb7hH8MSUJpSbSDYk0k2', openai: 'nova', gender: 'female', label: 'Female — British' },
  { id: 'river', eleven: 'SAz9YHcvj6GT2YYXdXww', openai: 'alloy', gender: 'neutral', label: 'Neutral' },
];

const DEFAULT_BY_GENDER = { male: 'wingman', female: 'matilda', neutral: 'river' };

// Words people actually say when asking for a voice.
const VOICE_ALIASES = {
  default: 'wingman', normal: 'wingman', jeremy: 'wingman', jarvis: 'wingman', calm: 'wingman',
  british: 'george', butler: 'daniel', formal: 'daniel',
  deep: 'brian', warm: 'matilda', soft: 'sarah',
};

// Old OpenAI voice names still stored for existing users (most were just the
// old default). They all fall back to Wingman's voice.
const LEGACY_OPENAI = new Set(['onyx', 'echo', 'fable', 'ballad', 'nova', 'shimmer', 'alloy']);

const byId = (id) => VOICE_OPTIONS.find((v) => v.id === id) || null;

function isValidVoice(id) { return !!byId(id); }

/** Resolve "male"/"female"/"neutral", an alias or a voice id to a voice id. */
function resolveVoice(input) {
  const v = String(input || '').trim().toLowerCase();
  if (DEFAULT_BY_GENDER[v]) return DEFAULT_BY_GENDER[v];
  if (VOICE_ALIASES[v]) return VOICE_ALIASES[v];
  if (isValidVoice(v)) return v;
  return null;
}

/** The voice option a user's replies are read in. */
function voiceFor(user) {
  const stored = String((user && user.voice_name) || '').trim().toLowerCase();
  if (!stored || LEGACY_OPENAI.has(stored)) return null;
  const v = byId(resolveVoice(stored));
  return v && v.eleven ? v : null; // null → Wingman's voice (ELEVENLABS_VOICE_ID)
}

// ── Speech → text ───────────────────────────────────────────────────────
const NON_LATIN = /[؀-ۿݐ-ݿऀ-ॿ]/;

/** Urdu/Hindi script → Roman Urdu, the way the user would type it. */
async function toRomanUrdu(text) {
  try {
    const out = await require('../llm/claude').complete(
      `Rewrite this voice-note transcript in Roman Urdu (Urdu written in English letters, the casual way people in Pakistan type on WhatsApp). Keep English words as they are. Do not translate, add or drop anything. Output only the rewritten text.\n\n${text}`,
      { model: config.anthropic.modelCheap || config.anthropic.model, maxTokens: 1500 },
    );
    const clean = String(out || '').trim();
    return clean || text;
  } catch (_) {
    return text; // the assistant still understands Urdu script
  }
}

async function transcribeOpenAI(audio, filename) {
  const form = new FormData();
  // Whisper infers the format from the filename and rejects ".opus".
  form.append('file', new Blob([audio]), filename);
  form.append('model', config.voice.sttModel);
  form.append('language', config.voice.sttLanguage);
  form.append('prompt', 'Bhai kal teen baje meeting rakh do. Mujhe email bhej dena. Traffic kaisa hai? Aaj sales kaisi rahi?');
  const res = await fetch(`${OPENAI}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.voice.apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('VOICE_BAD_KEY');
    if (res.status === 429 && /quota|billing/i.test(msg)) throw new Error('VOICE_NO_CREDIT');
    throw new Error(msg);
  }
  return String(data.text || '').trim();
}

/**
 * Transcribe a voice note (or any audio file).
 * @param {Buffer} audio  raw bytes (WhatsApp sends Ogg/Opus)
 * @returns {Promise<string>}
 */
async function transcribe(audio, { filename = 'voice.ogg' } = {}) {
  if (!enabled()) throw new Error('VOICE_NOT_CONFIGURED');
  if (useOpenAI()) return transcribeOpenAI(audio, filename);
  const { text } = await require('./elevenlabs').transcribe(audio, { filename });
  if (!text) return '';
  // Long recordings (meetings) are kept as-is — the model reads Urdu script fine.
  return NON_LATIN.test(text) && text.length < 3000 ? toRomanUrdu(text) : text;
}

// ── Text → speech ───────────────────────────────────────────────────────
/** Strip things that sound wrong read aloud (emoji, markdown, links). */
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, 'the link I sent')
    .replace(/[*_~`#>]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s*[•·\-–]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .trim();
}

/**
 * Turn a reply into a WhatsApp voice note. Long replies are trimmed — nobody
 * wants a three-minute voice note.
 * @param {string} text
 * @param {{user?: object, maxChars?: number}} [opts]
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function speak(text, { user = null, maxChars = 900 } = {}) {
  if (!enabled()) throw new Error('VOICE_NOT_CONFIGURED');
  const spoken = cleanForSpeech(text).slice(0, maxChars);
  if (!spoken) throw new Error('VOICE_EMPTY_TEXT');
  const v = voiceFor(user);

  if (!useOpenAI()) {
    const el = require('./elevenlabs');
    return el.speak(spoken, { maxChars, ...(v ? { voiceId: v.eleven } : {}) });
  }

  const res = await fetch(`${OPENAI}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.voice.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.voice.ttsModel,
      voice: (v && v.openai) || config.voice.ttsVoice,
      input: spoken,
      response_format: 'opus',
    }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('VOICE_BAD_KEY');
    throw new Error(`VOICE_TTS_${res.status}`);
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/ogg' };
}

/**
 * Should we reply with a voice note?
 * 'off' never, 'on_voice' only when they spoke to us (default), 'always' every time.
 */
function shouldSpeak(user, incomingWasVoice) {
  const pref = (user && user.voice_replies) || 'on_voice';
  if (!enabled() || pref === 'off') return false;
  if (pref === 'always') return true;
  return !!incomingWasVoice;
}

module.exports = {
  enabled, transcribe, speak, shouldSpeak, cleanForSpeech,
  VOICE_OPTIONS, VOICE_ALIASES, resolveVoice, isValidVoice, voiceFor,
};
