'use strict';

/**
 * Briefing & wrap CALLS — Wingman phones the user on WhatsApp.
 *
 * At the user's own briefing/wrap time (users who turned "Call me" on):
 *   1. the briefing is built exactly as for the text version (send:false),
 *   2. the ElevenLabs agent calls them on WhatsApp with it as context, reads it
 *      out, answers their questions (each one comes back to Wingman's brain via
 *      POST /voice/tools/ask) and stays on until they hang up,
 *   3. the scheduler polls the call; answered → a short note goes into the chat
 *      history (nothing is sent); missed / failed / no permission → the normal
 *      text briefing goes out, and the full version carries a voice note.
 * After 2 missed calls in a row calls pause (Meta revokes call permission after
 * 4 unanswered calls) and the user is told how to turn them back on.
 *
 * Voice notes work today on any number. Calls need a non-US WhatsApp business
 * number with calling enabled (see config.elevenlabs).
 */

const crypto = require('crypto');
const config = require('../config');
const { db, uuid } = require('../db');
const usersRepo = require('../db/users');
const el = require('./elevenlabs');

const PAUSE_AFTER_MISSES = 2;

// ── preferences ──────────────────────────────────────────────────────
function prefs(user) { return (user && user.preferences) || {}; }

/** The user's "call me for my briefing" switch (also turns voice notes on). */
function isOn(user) { return prefs(user).briefingCall === true; }

function setEnabled(userId, on) {
  usersRepo.updatePreferences(userId, {
    briefingCall: !!on,
    ...(on ? { briefingCallResetAt: new Date().toISOString() } : {}),
  });
  return { briefing_call: !!on, calls_available: config.elevenlabs.callsReady };
}

/** Voice notes ride along with every full briefing/wrap for users who opted in. */
function wantsVoice(user) { return config.elevenlabs.enabled && isOn(user); }

// ── call bookkeeping ─────────────────────────────────────────────────
function rows(userId, limit = 10) {
  return db.prepare('SELECT * FROM voice_calls WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, limit);
}

/** Missed calls in a row, counting only since the user last (re)enabled calls. */
function consecutiveMissed(user) {
  // created_at has 1-second resolution, so compare at that resolution too.
  const since = Math.floor((Date.parse(prefs(user).briefingCallResetAt || 0) || 0) / 1000) * 1000;
  let n = 0;
  for (const r of rows(user.id, 10)) {
    if (Date.parse(String(r.created_at).replace(' ', 'T') + 'Z') < since) break;
    if (r.status === 'answered') break;
    if (r.status === 'missed' || r.status === 'failed') n += 1;
  }
  return n;
}

function activeCall(userId) {
  return db.prepare("SELECT * FROM voice_calls WHERE user_id = ? AND status = 'calling' ORDER BY created_at DESC LIMIT 1").get(userId);
}

function shouldCall(user) {
  if (!config.elevenlabs.callsReady || !user || !user.phone || !isOn(user)) return false;
  if (activeCall(user.id)) return false;
  return consecutiveMissed(user) < PAUSE_AFTER_MISSES;
}

/** Shared secret the agent's webhook tool sends, so /voice/tools/ask can't be called by anyone else. */
function toolSecret() {
  const base = config.security.linkSecret || config.security.linkSecretFallback;
  return crypto.createHmac('sha256', String(base)).update('wingman-voice-tool').digest('hex').slice(0, 40);
}

function service(kind) {
  return kind === 'wrap' ? require('./endOfDayWrap') : require('./morningBriefing');
}

function label(kind) { return kind === 'wrap' ? 'evening wrap' : 'morning briefing'; }

function firstName(user) { return String((user && user.name) || '').trim().split(/\s+/)[0] || 'there'; }

/**
 * Which language to speak: 'hi' (Hindi/Urdu, spoken as an Urdu-English mix)
 * or 'en'. From the user's saved language, else what they write to Wingman,
 * judged by the cheap model and cached for a week.
 */
async function callLanguage(user) {
  const lang = String(user.language || '').toLowerCase();
  if (/^(ur|hi|urdu|hindi|roman)/.test(lang)) return 'hi';
  if (/^en/.test(lang)) return 'en';
  const p = prefs(user);
  if (p.callLanguage && Date.now() - (Date.parse(p.callLanguageAt) || 0) < 7 * 86400000) return p.callLanguage;
  let out = 'en';
  try {
    const recent = db.prepare(
      "SELECT content FROM conversations WHERE user_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 8",
    ).all(user.id).map((r) => String(r.content || '').slice(0, 200)).join('\n');
    if (recent.trim()) {
      const ans = await require('../llm/claude').complete(
        `Messages a user wrote:\n${recent}\n\nAre they mostly Urdu or Hindi (including Roman Urdu written in English letters)? Answer with exactly one word: urdu or english.`,
        { model: config.anthropic.modelCheap || config.anthropic.model, maxTokens: 5 },
      );
      out = /urdu/i.test(ans) ? 'hi' : 'en';
    }
  } catch (_) { /* default English */ }
  usersRepo.updatePreferences(user.id, { callLanguage: out, callLanguageAt: new Date().toISOString() });
  return out;
}

function openingLine(user, kind, lang) {
  const name = firstName(user);
  return lang === 'hi'
    ? `Assalam o alaikum ${name}, Wingman bol raha hoon. Aap ki ${kind === 'wrap' ? 'aaj ki wrap' : 'morning briefing'} tayyar hai. Shuru karoon?`
    : `Hi ${name}, it's Wingman with your ${label(kind)}. Shall I go through it?`;
}

function localTime(user, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: user.timezone || 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
    }).format(now);
  } catch (_) { return now.toISOString(); }
}

/**
 * Place the call. Returns { started } — when false, the caller sends the
 * normal text briefing instead.
 */
async function start(user, kind, { now = new Date() } = {}) {
  let text = '';
  try {
    const built = await service(kind).sendForUser(user.id, { now, send: false });
    text = (built && built.text) || '';
  } catch (e) {
    return { started: false, error: `build failed: ${e.message}` };
  }
  if (!text) return { started: false, error: 'empty briefing' };

  const id = uuid();
  const token = crypto.randomBytes(18).toString('hex');
  db.prepare('INSERT INTO voice_calls (id, user_id, kind, call_token, briefing_text) VALUES (?, ?, ?, ?, ?)')
    .run(id, user.id, kind, token, text);

  try {
    const lang = await callLanguage(user);
    const r = await el.startWhatsAppCall({
      waUserId: user.phone,
      language: lang,
      firstMessage: openingLine(user, kind, lang),
      dynamicVariables: {
        user_name: firstName(user),
        briefing_kind: label(kind),
        call_purpose: `You placed this call to deliver their ${label(kind)}. Open, then take them through it.`,
        briefing: el.forSpeech(text).slice(0, 6000),
        local_time: localTime(user, now),
        call_token: token,
      },
    });
    db.prepare('UPDATE voice_calls SET conversation_id = ?, detail = ? WHERE id = ?')
      .run(r.conversationId, String(r.message || '').slice(0, 300), id);
    console.log(`[briefingCall] ${kind} call started for ${user.id} (${r.conversationId || 'no id yet'})`);
    return { started: true, id };
  } catch (e) {
    db.prepare("UPDATE voice_calls SET status = 'failed', detail = ?, finished_at = datetime('now') WHERE id = ?")
      .run(String(e.message).slice(0, 300), id);
    console.warn(`[briefingCall] could not start ${kind} call for ${user.id}: ${e.message}`);
    return { started: false, error: e.message };
  }
}

/** Was the call actually picked up and talked on? */
function wasAnswered(conv) {
  const meta = conv.metadata || {};
  const userTurns = (conv.transcript || []).filter((t) => t.role === 'user' && String(t.message || '').trim()).length;
  return userTurns > 0 || Number(meta.call_duration_secs || 0) >= 20;
}

async function finish(row, status, { duration = null, detail = '' } = {}) {
  db.prepare("UPDATE voice_calls SET status = ?, duration_secs = ?, detail = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, duration, String(detail || '').slice(0, 500), row.id);
  const user = usersRepo.getById(row.user_id);
  if (!user) return;

  if (row.kind === 'inbound' && status !== 'answered') return; // they hung up before talking — nothing to do

  if (status === 'answered') {
    // Keep it in the chat history so a later WhatsApp message can refer to it.
    const what = row.kind === 'inbound'
      ? `${user.name ? firstName(user) : 'You'} called me on WhatsApp`
      : `I talked ${user.name ? firstName(user) : 'you'} through the ${label(row.kind)} on a call`;
    try {
      require('../db/conversations').logMessage({
        userId: user.id,
        role: 'assistant',
        content: `📞 (Call) ${what} (${Math.max(1, Math.round((duration || 0) / 60))} min).${detail ? ` Summary: ${detail}` : ''}`,
        metadata: { direction: 'outbound', source: 'call', mediaType: 'call' },
      });
    } catch (_) { /* best-effort */ }
    return;
  }

  // Missed / failed → the normal text briefing (template outside the window);
  // its full version carries the voice note.
  try {
    await service(row.kind).sendForUser(user.id, { now: new Date() });
  } catch (e) {
    console.warn(`[briefingCall] fallback ${row.kind} send failed for ${user.id}: ${e.message}`);
  }
  const fresh = usersRepo.getById(user.id);
  if (fresh && consecutiveMissed(fresh) === PAUSE_AFTER_MISSES) {
    try {
      await require('../whatsapp/client').sendMessage(fresh.phone,
        "I tried calling for your last two briefings but couldn't reach you, so I'll send them as messages (with a voice note) for now. Tell me \"call me again\" whenever you want the calls back.");
    } catch (_) { /* best-effort */ }
  }
}

/** Scheduler (every minute): settle calls whose outcome is known. */
async function runPoll() {
  if (!config.elevenlabs.enabled) return { checked: 0 };
  const open = db.prepare("SELECT * FROM voice_calls WHERE status IN ('calling', 'live') ORDER BY created_at LIMIT 20").all();
  let settled = 0;
  for (const row of open) {
    const ageMin = (Date.now() - Date.parse(String(row.created_at).replace(' ', 'T') + 'Z')) / 60000;
    try {
      if (!row.conversation_id) {
        if (row.kind === 'inbound') {
          // ElevenLabs didn't tell us the conversation id — nothing to poll.
          if (ageMin > 60) { await finish(row, 'ended', { detail: 'inbound call (no conversation id)' }); settled += 1; }
          continue;
        }
        if (ageMin > 3) { await finish(row, 'failed', { detail: 'no conversation id' }); settled += 1; }
        continue;
      }
      const conv = await el.getConversation(row.conversation_id);
      const status = String(conv.status || '');
      if (status === 'done' || status === 'failed') {
        const meta = conv.metadata || {};
        const summary = (conv.analysis && conv.analysis.transcript_summary) || meta.termination_reason || '';
        await finish(row, wasAnswered(conv) ? 'answered' : 'missed', {
          duration: Number(meta.call_duration_secs || 0), detail: summary,
        });
        settled += 1;
      } else if (ageMin > config.elevenlabs.callTimeoutMinutes) {
        // Still "initiated" — e.g. the permission request was never answered.
        await finish(row, 'missed', { detail: `no outcome after ${Math.round(ageMin)} min (status ${status})` });
        settled += 1;
      }
    } catch (e) {
      console.warn(`[briefingCall] poll ${row.id}: ${e.message}`);
      if (ageMin > config.elevenlabs.callTimeoutMinutes) { await finish(row, 'failed', { detail: e.message }); settled += 1; }
    }
  }
  return { checked: open.length, settled };
}

// ── inbound calls (the user calls Wingman on WhatsApp) ─────────────────
/** Find the caller's number in whatever shape ElevenLabs sends it. */
function callerNumber(body) {
  const KEYS = /^(caller_id|caller|from|whatsapp_user_id|wa_id|user_id|phone_number|caller_phone_number|user_phone)$/i;
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (KEYS.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        const d = String(v).replace(/\D/g, '');
        if (d.length >= 8) return d;
      }
    }
    for (const v of Object.values(o)) {
      const r = walk(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(body, 0);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * ElevenLabs "conversation initiation" webhook for a call the USER placed to
 * Wingman. Identify them by their WhatsApp number, hand the agent today's
 * snapshot + a per-call token (so ask_wingman answers from THEIR data), and
 * greet them by name in their language. Unknown callers get a polite agent
 * with no data access. Must answer fast — the phone is already ringing.
 */
async function inbound(body = {}, { now = new Date() } = {}) {
  const phone = callerNumber(body);
  const user = phone ? usersRepo.getByPhone(phone) : null;
  const convId = (body && (body.conversation_id || body.conversationId)) || null;

  if (!user) {
    console.log(`[briefingCall] inbound call from unknown number ${phone ? `…${phone.slice(-4)}` : '(none)'}`);
    return {
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        user_name: 'there',
        briefing_kind: 'call',
        call_purpose: "Someone who isn't signed up to Wingman called you. Be friendly, explain you're Wingman, an AI chief of staff on WhatsApp, and that they can sign up at imyourwingman.ai. You have no access to anyone's data on this call — never use ask_wingman.",
        briefing: '',
        local_time: '',
        call_token: '',
      },
    };
  }

  // The phone is already ringing — answer within ~2s. Reuse a recent
  // briefing if there is one; otherwise the agent asks Wingman for everything.
  let text = '';
  try {
    const recent = db.prepare("SELECT briefing_text FROM voice_calls WHERE user_id = ? AND briefing_text IS NOT NULL AND briefing_text <> '' AND created_at > datetime('now', '-6 hours') ORDER BY created_at DESC LIMIT 1").get(user.id);
    if (recent) text = recent.briefing_text;
    else {
      const built = await withTimeout(service('briefing').sendForUser(user.id, { now, send: false }), 1500);
      text = (built && built.text) || '';
    }
  } catch (_) { /* fine — the agent can ask */ }

  const token = crypto.randomBytes(18).toString('hex');
  db.prepare("INSERT INTO voice_calls (id, user_id, kind, call_token, briefing_text, conversation_id, status) VALUES (?, ?, 'inbound', ?, ?, ?, 'live')")
    .run(uuid(), user.id, token, text, convId);

  let lang = 'en';
  try { lang = await withTimeout(callLanguage(user), 800) || 'en'; } catch (_) { /* English */ }
  const name = firstName(user);
  const first = lang === 'hi'
    ? `Assalam o alaikum ${name}, Wingman bol raha hoon. Bataiye, kya kar sakta hoon?`
    : `Hey ${name}, Wingman here. What can I do for you?`;
  console.log(`[briefingCall] inbound call from ${user.id} (${lang})`);

  return {
    type: 'conversation_initiation_client_data',
    dynamic_variables: {
      user_name: name,
      briefing_kind: 'snapshot of today',
      call_purpose: "THEY called YOU. Greet them and help with whatever they ask. The notes below are today's snapshot for context — don't read them out unless they ask about their day.",
      briefing: el.forSpeech(text).slice(0, 6000),
      local_time: localTime(user, now),
      call_token: token,
    },
    conversation_config_override: { agent: { first_message: first, language: lang } },
  };
}

/** The agent asked Wingman something mid-call. */
async function answer(token, question, context = '') {
  const row = token
    ? db.prepare("SELECT * FROM voice_calls WHERE call_token = ? AND created_at > datetime('now', '-3 hours')").get(String(token))
    : null;
  if (!row) return { error: 'UNKNOWN_CALL' };
  const user = usersRepo.getById(row.user_id);
  if (!user) return { error: 'UNKNOWN_USER' };
  const reply = await require('../engine/conversation').answerForCall(user, question, { context });
  return { answer: reply || "Sorry, I couldn't get that right now — I'll message you on WhatsApp." };
}

/** Read a full briefing/wrap aloud and send it as a WhatsApp voice note (window must be open). */
async function sendVoiceNote(user, text) {
  if (!wantsVoice(user) || !text) return false;
  const cloudApi = require('../whatsapp/cloudApi');
  if (!cloudApi.ready()) return false;
  try {
    const v = require('./voice').voiceFor(user);
    const { buffer, mimeType } = await el.speak(text, v ? { voiceId: v.eleven } : {});
    await cloudApi.sendAudio(user.phone, buffer, { mimeType });
    console.log(`[briefingCall] voice note sent to ${user.id} (${Math.round(buffer.length / 1024)} KB)`);
    return true;
  } catch (e) {
    console.warn(`[briefingCall] voice note failed for ${user.id}: ${e.message}`);
    return false;
  }
}

module.exports = {
  isOn, setEnabled, wantsVoice, shouldCall, start, runPoll, answer, sendVoiceNote,
  toolSecret, consecutiveMissed, wasAnswered, callLanguage, inbound, callerNumber,
};
