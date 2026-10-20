'use strict';

const claude = require('../llm/claude');
const usersRepo = require('../db/users');
const conversationsRepo = require('../db/conversations');
const memoryRepo = require('../db/userMemory');

/**
 * Learns durable things about a user from how they actually talk to Wingman —
 * preferences, habits, who they work with, what they're working on — and stores
 * them so the assistant carries context across conversations instead of
 * starting from zero every time.
 *
 * Deliberately conservative: only facts that will still be true next week.
 */

const SYSTEM = `You extract DURABLE facts about a user from their chat with an AI assistant, plus any CORRECTIONS they gave the assistant about how it should behave.

Reply with ONLY compact JSON, no prose, no code fences:
{"facts": [{"fact": string, "category": "preference"|"habit"|"relationship"|"project"|"context"}],
 "rules": [string]}

"rules" = standing instructions for the ASSISTANT that the user gave or clearly implied by correcting it: tone, length, language, format, wording, what to stop/start doing ("your replies are too long" → "Keep replies short — 2-3 lines"; "emoji mat lagao" → "Don't use emojis"; "mujhe sir mat kaho" → "Never call the user sir"; "why are you asking again, just do it" → "Don't re-ask for confirmation on small things"). Only when the USER said it — never from the assistant's own lines. Each rule a short imperative in English. Skip rules already in KNOWN RULES.

What counts as durable — things still true next week:
- preference: how they like things done ("prefers short replies", "likes meetings after 2pm")
- habit: recurring behaviour ("checks sales every Monday morning", "works late on Thursdays")
- relationship: people who recur and who they are ("Amir is his business partner")
- project: ongoing work ("running the Stack project with the Rad team")
- context: stable situation ("based in Karachi", "runs a Shopify store selling apparel")

Do NOT extract:
- One-off requests, or anything about a single meeting/email/task
- Anything already in the KNOWN list (or a reworded version of it)
- Temporary state ("is busy today")
- Guesses. If the conversation doesn't clearly show it, leave it out.

Write each fact as a short third-person statement. Return {"facts":[],"rules":[]} when there is nothing durable — that is the normal, expected result for most conversations.`;

/** Parse {facts, rules} (or a bare facts array, from older prompts). */
function parseLearned(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const s = text.indexOf('{');
  const a = text.indexOf('[');
  if (s !== -1 && (a === -1 || s < a)) {
    try {
      const o = JSON.parse(text.slice(s, text.lastIndexOf('}') + 1));
      return {
        facts: Array.isArray(o.facts) ? o.facts : [],
        rules: Array.isArray(o.rules) ? o.rules.filter((r) => typeof r === 'string' && r.trim()) : [],
      };
    } catch (_) { /* fall through */ }
  }
  return { facts: parseFacts(raw), rules: [] };
}

/** Strip code fences / prose and parse the JSON array. */
function parseFacts(raw) {
  if (!raw) return [];
  const text = String(raw).replace(/```json|```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

// Re-analyse only after this many new messages, to keep the cost sane.
const MIN_NEW_MESSAGES = 10;

const VALID_CATEGORIES = new Set(['preference', 'habit', 'relationship', 'project', 'context']);

/**
 * Analyse a user's recent conversation and store anything new it reveals.
 *
 * @param {string} userId
 * @param {Object} [opts]
 * @param {number} [opts.messages=40] how much recent history to consider
 * @param {boolean} [opts.persist=true]
 */
async function learnForUser(userId, { messages = 40, persist = true } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { learned: [], skipped: 'no_user' };

  const history = conversationsRepo.historyForUser(userId, messages);
  if (history.length < 6) return { learned: [], skipped: 'not_enough_history' };

  // Throttle: this costs a Claude call, so only re-analyse once enough NEW
  // messages have accumulated. Counted from the full conversation total (not
  // the capped history window, which would stop growing and freeze the check).
  const prefs = user.preferences || {};
  const lastCount = prefs.lastLearnedMessageCount || 0;
  const totalNow = conversationsRepo.countForUser(userId);
  if (persist && totalNow < lastCount + MIN_NEW_MESSAGES) {
    return { learned: [], skipped: 'not_enough_new_messages' };
  }

  const known = memoryRepo.listForUser(userId).map((m) => `- ${m.fact}`).join('\n') || '(nothing yet)';
  const rulesRepo = require('../db/userRules');
  const knownRules = rulesRepo.listForUser(userId).filter((r) => r.kind === 'behavior').map((r) => `- ${r.text}`).join('\n') || '(none)';
  const transcript = history
    .map((m) => `${m.role === 'assistant' ? 'Wingman' : 'User'}: ${(m.content || '').slice(0, 400)}`)
    .join('\n');

  let raw;
  try {
    raw = await claude.chat(
      [{ role: 'user', content: `KNOWN FACTS:\n${known}\n\nKNOWN RULES:\n${knownRules}\n\nCONVERSATION:\n${transcript}` }],
      { system: SYSTEM, maxTokens: 700, model: require('../config').anthropic.modelCheap },
    );
  } catch (err) {
    console.warn('[behaviorLearner] extraction failed:', err.message);
    return { learned: [], error: err.message };
  }

  const parsed = parseLearned(claude.textOf ? (typeof raw === 'string' ? raw : claude.textOf(raw)) : raw);
  const facts = parsed.facts;
  const learned = [];
  const rulesLearned = [];
  for (const text of parsed.rules.slice(0, 4)) {
    if (!persist) { rulesLearned.push(text.trim()); continue; }
    const r = rulesRepo.add(userId, { kind: 'behavior', text: text.trim() });
    if (r.added) rulesLearned.push(text.trim());
  }
  for (const f of facts.slice(0, 8)) {
    if (!f || typeof f.fact !== 'string') continue;
    const category = VALID_CATEGORIES.has(f.category) ? f.category : 'context';
    if (!persist) { learned.push({ fact: f.fact, category }); continue; }
    const r = memoryRepo.add(userId, { fact: f.fact, category, source: 'learned' });
    if (r.added) learned.push({ fact: f.fact, category });
  }

  if (persist) {
    usersRepo.updatePreferences(userId, { lastLearnedMessageCount: totalNow });
  }
  if (learned.length || rulesLearned.length) {
    console.log(`[behaviorLearner] learned ${learned.length} fact(s), ${rulesLearned.length} rule(s) for ${user.phone}`);
  }
  return { learned, rules: rulesLearned };
}

/** Run the learner for every onboarded user (called from the scheduler). */
async function runAllUsers() {
  const users = usersRepo.listOnboarded();
  const results = [];
  for (const u of users) {
    try {
      const r = await learnForUser(u.id);
      if (r.learned && r.learned.length) results.push({ phone: u.phone, learned: r.learned.length });
    } catch (err) {
      console.warn('[behaviorLearner] failed for', u.phone, err.message);
    }
  }
  return results;
}

module.exports = { learnForUser, runAllUsers, parseFacts, parseLearned };
