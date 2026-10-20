'use strict';

/**
 * How THIS user writes — learned from their own words, so Wingman talks the way
 * they talk and drafts emails that sound like them, instead of one generic
 * "assistant voice" for everybody.
 *
 * Two samples:
 *   - their WhatsApp messages to Wingman → how to TALK to them (language mix,
 *     length, formality, emoji, greetings)
 *   - their SENT Gmail → how to WRITE AS them (greeting, sign-off, length, tone,
 *     phrases they actually use)
 *
 * Stored on preferences.styleProfile; injected into every chat turn by
 * promptBlock(). Rebuilt by runDue() when there is enough new material.
 */

const usersRepo = require('../db/users');
const { db } = require('../db');

const MAX_CHAT_SAMPLES = 120;
const MAX_EMAIL_SAMPLES = 15;
const MIN_CHAT_SAMPLES = 8;
const REBUILD_AFTER_MESSAGES = 30;
const REBUILD_AFTER_DAYS = 7;

const SYSTEM = `You study how ONE person writes, so an AI assistant can (a) talk to them in their own style and (b) draft emails that sound exactly like them.

You get two samples: CHAT (their WhatsApp messages to the assistant) and EMAIL (emails they sent). Either may be empty.

Reply with ONLY compact JSON, no prose, no code fences:
{
 "chat": {
   "language": "exact language/script mix, e.g. 'Roman Urdu mixed with English', 'English', 'Urdu script'",
   "length": "how long their messages are, e.g. 'very short, 1-2 lines'",
   "formality": "e.g. 'very casual, says bro/yar'",
   "emoji": "none | rare | frequent — and which ones",
   "habits": ["short concrete observations: greetings they use, how they ask for things, typos they don't care about, etc."],
   "reply_guidance": "2-3 sentences: exactly how the assistant should reply to this person (language, length, tone, emoji, structure). Concrete, not generic."
 },
 "email": {
   "language": "...",
   "greeting": "how they open emails, with real examples",
   "signoff": "how they close, with the exact sign-off text they use",
   "length": "...",
   "tone": "...",
   "phrases": ["phrases they actually reuse"],
   "draft_guidance": "2-3 sentences: how to draft an email AS this person so the recipient can't tell it wasn't them."
 }
}
Rules:
- Base everything ONLY on the samples. Never invent. If a sample is empty or too thin, set that whole section to null.
- Be specific to THIS person. "Friendly and professional" is useless; "opens with 'Hi Ali,' no small talk, 3-4 lines, signs off 'Best, Aamir'" is useful.
- Ignore quoted replies, forwarded text and automatic signatures/disclaimers.`;

function prefsOf(user) {
  return (user && user.preferences) || {};
}

/** Their own WhatsApp messages (newest last), cleaned. */
function chatSamples(userId, limit = MAX_CHAT_SAMPLES) {
  const rows = db.prepare(`
    SELECT content FROM conversations
    WHERE user_id = ? AND role = 'user' AND content IS NOT NULL AND TRIM(content) <> ''
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit * 2);
  const out = [];
  for (const r of rows) {
    const t = String(r.content || '').trim();
    // Skip media placeholders / system-ish lines / bare yes-no.
    if (/^\[(image|audio|voice|video|document|sticker|location)/i.test(t)) continue;
    if (t.length < 3) continue;
    out.push(t.slice(0, 400));
    if (out.length >= limit) break;
  }
  return out.reverse();
}

/** Drop quoted history, forwarded blocks and common signatures from a sent email. */
function cleanEmailBody(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^\s*On .{5,120}wrote:\s*$/i.test(line)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && kept.length > 2) break;
    if (/^\s*>/.test(line)) continue;
    if (/^\s*Sent from my (iPhone|Android|mobile)/i.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 900);
}

/** Bodies of emails they recently sent from Gmail (primary account). */
async function emailSamples(user, limit = MAX_EMAIL_SAMPLES) {
  try {
    if (!require('../auth/googleAuth').isEmailConnected(user)) return [];
    const gmail = require('./gmail');
    const account = (gmail.accountsFor(user) || [null])[0] || null;
    const ids = await gmail.listMessageIds(user, { maxResults: limit * 2, query: 'in:sent -in:chats newer_than:180d', account });
    const out = [];
    for (const id of ids) {
      try {
        const m = await gmail.getMessage(user, id, account);
        const body = cleanEmailBody(String(m.body || '').split('\n\n[Email attachments]')[0]);
        if (body.length < 40) continue;
        out.push(`Subject: ${m.subject || ''}\n${body}`);
        if (out.length >= limit) break;
      } catch (_) { /* skip one */ }
    }
    return out;
  } catch (err) {
    console.warn('[styleProfile] sent-mail read failed:', err.message);
    return [];
  }
}

function parse(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { return null; }
}

/** Learn (or relearn) this user's style now. */
async function build(userOrId, { llm } = {}) {
  const user = typeof userOrId === 'object' ? usersRepo.getById(userOrId.id) : usersRepo.getById(userOrId);
  if (!user) return { skipped: 'no_user' };
  const chats = chatSamples(user.id);
  const emails = await emailSamples(user);
  if (chats.length < MIN_CHAT_SAMPLES && emails.length < 3) return { skipped: 'not_enough_samples', chats: chats.length, emails: emails.length };

  const prompt = `CHAT (${chats.length} messages they wrote):\n${chats.length ? chats.map((c) => `- ${c}`).join('\n') : '(empty)'}\n\n`
    + `EMAIL (${emails.length} emails they sent):\n${emails.length ? emails.map((e, i) => `#${i + 1}\n${e}`).join('\n\n') : '(empty)'}`;

  const complete = llm || ((p, o) => require('../llm/claude').complete(p, o));
  let parsed;
  try {
    parsed = parse(await complete(prompt, { system: SYSTEM, maxTokens: 900 }));
  } catch (err) {
    console.warn('[styleProfile] analysis failed:', err.message);
    return { error: err.message };
  }
  if (!parsed || (!parsed.chat && !parsed.email)) return { skipped: 'unparseable' };

  const profile = {
    chat: chats.length >= MIN_CHAT_SAMPLES ? parsed.chat || null : null,
    email: emails.length >= 3 ? parsed.email || null : null,
    samples: { chat: chats.length, email: emails.length },
    builtAt: new Date().toISOString(),
    atMessageCount: require('../db/conversations').countForUser(user.id),
  };
  usersRepo.updatePreferences(user.id, { styleProfile: profile });
  return { profile };
}

/** Rebuild for users who have no profile yet or enough new material. A few per tick. */
async function runDue({ now = new Date(), max = 5, llm } = {}) {
  const done = [];
  for (const u of usersRepo.listOnboarded()) {
    if (done.length >= max) break;
    const p = prefsOf(u).styleProfile;
    const tried = prefsOf(u).styleTriedAt ? Date.parse(prefsOf(u).styleTriedAt) : 0;
    if (now - tried < 24 * 3600e3) continue; // runs hourly; one attempt a day per user
    const total = require('../db/conversations').countForUser(u.id);
    if (p) {
      const age = p.builtAt ? (now - Date.parse(p.builtAt)) / 86400e3 : Infinity;
      const newMsgs = total - (p.atMessageCount || 0);
      if (age < 1) continue; // at most once a day
      if (newMsgs < REBUILD_AFTER_MESSAGES && age < REBUILD_AFTER_DAYS) continue;
    }
    try {
      usersRepo.updatePreferences(u.id, { styleTriedAt: now.toISOString() });
      const r = await build(u, { llm });
      if (r.profile) done.push(u.id);
    } catch (err) {
      console.warn('[styleProfile] failed for', u.phone, err.message);
    }
  }
  return done;
}

/**
 * Called after a chat turn: build the first profile as soon as there is enough
 * to learn from, and refresh after enough new messages. At most one try a day.
 */
async function maybeBuild(user) {
  const p = prefsOf(user);
  const tried = p.styleTriedAt ? Date.parse(p.styleTriedAt) : 0;
  if (Date.now() - tried < 24 * 3600e3) return { skipped: 'tried_today' };
  const total = require('../db/conversations').countForUser(user.id);
  const sp = p.styleProfile;
  if (sp && total - (sp.atMessageCount || 0) < REBUILD_AFTER_MESSAGES) return { skipped: 'fresh' };
  usersRepo.updatePreferences(user.id, { styleTriedAt: new Date().toISOString() });
  return build(user);
}

const list = (v) => (Array.isArray(v) ? v.filter(Boolean).slice(0, 6).join('; ') : '');

/** System-prompt block: how to talk to them, and how to write as them. */
function promptBlock(user) {
  const p = prefsOf(user).styleProfile;
  if (!p || (!p.chat && !p.email)) return '';
  const name = String((user && user.name) || '').trim().split(/\s+/)[0] || 'the user';
  const out = [];
  if (p.chat) {
    const c = p.chat;
    out.push(`\n\n--- HOW ${name.toUpperCase()} TALKS — TALK THE SAME WAY (learned from their own messages) ---`);
    if (c.language) out.push(`Language: ${c.language}`);
    if (c.length) out.push(`Their message length: ${c.length}`);
    if (c.formality) out.push(`Formality: ${c.formality}`);
    if (c.emoji) out.push(`Emoji: ${c.emoji}`);
    if (list(c.habits)) out.push(`Habits: ${list(c.habits)}`);
    if (c.reply_guidance) out.push(`How to reply to them: ${c.reply_guidance}`);
    out.push('This is how THEY communicate, so it overrides your default tone and the generic personality settings. Mirror their language mix, length and emoji use. Do not mention that you studied their style.');
  }
  if (p.email) {
    const e = p.email;
    out.push(`\n\n--- WRITING EMAILS AS ${name.toUpperCase()} (learned from emails they actually sent) ---`);
    if (e.language) out.push(`Language: ${e.language}`);
    if (e.greeting) out.push(`Greeting: ${e.greeting}`);
    if (e.signoff) out.push(`Sign-off: ${e.signoff}`);
    if (e.length) out.push(`Length: ${e.length}`);
    if (e.tone) out.push(`Tone: ${e.tone}`);
    if (list(e.phrases)) out.push(`Phrases they use: ${list(e.phrases)}`);
    if (e.draft_guidance) out.push(`How to draft: ${e.draft_guidance}`);
    out.push('Every email or reply you write for them (Gmail or business mail) must read as if they wrote it themselves — their greeting, their sign-off, their length. Not a generic "professional assistant" email.');
  }
  return out.join('\n');
}

module.exports = { build, runDue, maybeBuild, promptBlock, chatSamples, cleanEmailBody, parse };
