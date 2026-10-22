'use strict';

const claude = require('../llm/claude');

/**
 * Turn a user's goal into a short, concrete action plan + a couple of proactive
 * ideas the assistant can offer. Best-effort — returns empty arrays on failure so
 * a goal is still created even if the model call fails.
 */

const SYSTEM = `You are a practical goal coach. Given a user's goal, break it into a SHORT, concrete action plan (3-6 ordered steps) they can actually follow, plus 1-2 proactive ideas of things YOU (their assistant) could do to help move it forward.
Return ONLY JSON: {"steps": ["step 1", "step 2", ...], "ideas": ["idea 1", ...]}.
Rules: steps are short imperative actions, realistic, ordered, no fluff. ideas are things the assistant can DO (e.g. "remind you every Monday morning", "find local classes and prices"). Keep everything tight and useful. Write EVERY step and idea in the language named on the "Write in:" line — never switch language because of where the user lives.`;

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (_) { return null; }
}

const strArr = (x) => (Array.isArray(x) ? x.map((v) => String(v || '').trim()).filter(Boolean) : []);

async function plan({ title, detail = '', targetDate = null, language = 'English' } = {}) {
  const prompt = [
    `Write in: ${language}`,
    `Goal: ${title}`,
    detail ? `Context: ${detail}` : null,
    targetDate ? `Target date: ${targetDate}` : null,
  ].filter(Boolean).join('\n');

  let raw = '';
  try { raw = await claude.complete(prompt, { system: SYSTEM, maxTokens: 700, model: require('../config').anthropic.modelDeep }); }
  catch (_) { return { steps: [], ideas: [] }; }

  const o = extractJson(raw) || {};
  return { steps: strArr(o.steps).slice(0, 8), ideas: strArr(o.ideas).slice(0, 4) };
}

module.exports = { plan };
