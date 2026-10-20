'use strict';

const claude = require('../llm/claude');

/**
 * Turn raw meeting notes (typed now; a transcript later) into a clean,
 * structured summary + action items. Pure function over the notes — it never
 * invents facts. Returns a normalized object even if the model misbehaves.
 */

const SYSTEM = `You are a meeting scribe. You are given the raw notes from a meeting and you turn them into a clean, structured summary.

Return ONLY a JSON object, no markdown and no commentary, with exactly this shape:
{
  "noContent": false,
  "overview": "2-3 sentence plain-English summary of what the meeting was about and where it landed",
  "discussion": ["a key point discussed", "..."],
  "decisions": ["a decision that was made", "..."],
  "actions": [{ "task": "what needs doing", "owner": "person's name, or empty string if unassigned", "due": "when, e.g. 'Friday' or 'Next week', or empty string", "priority": "High" | "Medium" | "Low" }],
  "openQuestions": ["something left unresolved", "..."],
  "followUps": ["a follow-up to schedule or send", "..."],
  "agenda": [{ "item": "an agenda point", "status": "done" | "partial" | "not_discussed", "note": "one line: where it landed / what is still open" }],
  "unresolved": ["a topic that still needs another conversation or meeting to close", "..."]
}

Rules:
- Base everything ONLY on the notes. Do not invent people, dates, or decisions.
- Use an empty array [] for any section with nothing in it.
- Keep each item short and concrete.
- Owner must be a name that appears in the notes/attendees, otherwise empty string.
- "agenda": only when an AGENDA is given. One entry per agenda point, in order: "done" = settled/decided, "partial" = discussed but not closed, "not_discussed" = never came up. Judge only from the notes. With no agenda, use [].
- "unresolved": topics (from the agenda OR the discussion) that were left open and need the people to meet or talk again — not small to-dos that one person can just do (those are actions). [] if everything landed.
- CRITICAL: If the notes are missing, empty, unintelligible, corrupted, just filler/repetition, or contain no real meeting discussion, set "noContent": true, "overview": "" and EVERY array empty. In that case do NOT describe the recording or transcript quality, and do NOT invent any action items, questions or follow-ups. Otherwise set "noContent": false.`;

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch (_) { return null; }
}

const strArr = (x) => (Array.isArray(x) ? x.map((v) => String(v || '').trim()).filter(Boolean) : []);

function normalize(p) {
  const o = p || {};
  return {
    noContent: o.noContent === true,
    overview: typeof o.overview === 'string' ? o.overview.trim() : '',
    discussion: strArr(o.discussion),
    decisions: strArr(o.decisions),
    actions: (Array.isArray(o.actions) ? o.actions : [])
      .map((a) => ({
        task: String((a && a.task) || '').trim(),
        owner: String((a && a.owner) || '').trim(),
        due: String((a && a.due) || '').trim(),
        priority: ['High', 'Medium', 'Low'].includes(a && a.priority) ? a.priority : 'Medium',
      }))
      .filter((a) => a.task),
    openQuestions: strArr(o.openQuestions),
    followUps: strArr(o.followUps),
    agenda: (Array.isArray(o.agenda) ? o.agenda : [])
      .map((a) => ({
        item: String((a && a.item) || '').trim(),
        status: ['done', 'partial', 'not_discussed'].includes(a && a.status) ? a.status : 'partial',
        note: String((a && a.note) || '').trim(),
      }))
      .filter((a) => a.item),
    unresolved: strArr(o.unresolved),
  };
}

/**
 * @param {{ title?: string, attendees?: Array<{name?:string}>, notes?: string }} meeting
 * @returns {Promise<object>} normalized summary
 */
async function summarize({ title, attendees = [], notes, agenda = '' } = {}) {
  const who = (Array.isArray(attendees) ? attendees : [])
    .map((a) => a && a.name)
    .filter(Boolean)
    .join(', ');

  const prompt = [
    title ? `Meeting: ${title}` : null,
    who ? `Attendees: ${who}` : null,
    agenda && String(agenda).trim() ? `AGENDA (from the calendar invite):\n${String(agenda).trim().slice(0, 2000)}` : null,
    '',
    'Raw notes:',
    (notes && String(notes).trim()) || '(no notes were taken)',
  ]
    .filter((x) => x !== null)
    .join('\n');

  // Budget for the OUTPUT summary must be generous: a real meeting's structured
  // JSON (overview + discussion + decisions + multi-field actions + questions +
  // follow-ups) easily runs past a small cap, and a truncated response is
  // invalid JSON → parse fails → we'd silently drop a real meeting as "empty".
  // (That's exactly what a 1500-token cap did to a 26k-char transcript.)
  let raw = await claude.complete(prompt, { system: SYSTEM, maxTokens: 8000 });
  let parsed = extractJson(raw);
  if (!parsed) {
    // A parse miss on a non-trivial transcript is almost always truncation or
    // stray prose — retry once, demanding compact JSON, before giving up.
    console.warn(`[meetingNotes] summary JSON parse failed (raw ${raw ? raw.length : 0} chars) — retrying`);
    raw = await claude.complete(
      `${prompt}\n\nReturn ONLY the JSON object, compact, with no commentary before or after.`,
      { system: SYSTEM, maxTokens: 8000 },
    );
    parsed = extractJson(raw);
    if (!parsed) console.warn(`[meetingNotes] summary still unparseable; raw head: ${String(raw || '').slice(0, 200)}`);
  }
  return normalize(parsed);
}

module.exports = { summarize, normalize };
