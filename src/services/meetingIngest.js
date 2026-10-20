'use strict';

/**
 * Shared meeting pipeline: an audio recording → transcript → structured summary →
 * (Drive save) → (email the user) → (action items become real tasks). Both the
 * app's manual /transcribe upload AND the notetaker bot funnel through here, so
 * the two paths can never drift apart.
 */

const meetingsRepo = require('../db/meetings');
const meetingNotes = require('./meetingNotes');
const meetingMailer = require('./meetingMailer');
const tasksRepo = require('../db/tasks');
const t = require('../utils/time');

const AUDIO_EXT = {
  'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'mp4', 'video/mp4': 'mp4',
};
function extOfType(ct) {
  const base = String(ct || '').split(';')[0].trim().toLowerCase();
  return AUDIO_EXT[base] || 'webm';
}

// Action priority label → task priority number (1 = highest).
function priorityNum(p) {
  return p === 'High' ? 1 : p === 'Low' ? 5 : 3;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Turn an action item's free-text "due" ("Tomorrow at 3:00 PM", "Friday",
 * "Next week", "Today") into an ISO datetime in the user's timezone, so the task
 * gets a real reminder. Returns null when no date can be read.
 */
function parseDueToISO(due, tz = 'Asia/Karachi', now = new Date()) {
  const s = String(due || '').trim().toLowerCase();
  if (!s || s.includes('no date')) return null;

  let dayOffset = null;
  if (s.includes('today')) dayOffset = 0;
  else if (s.includes('tomorrow')) dayOffset = 1;
  else if (s.includes('next week')) dayOffset = 7;
  else if (s.includes('this week')) dayOffset = 2;
  else {
    for (let i = 0; i < 7; i++) {
      if (s.includes(WEEKDAYS[i])) {
        const todayDow = now.getDay();
        let diff = (i - todayDow + 7) % 7;
        if (diff === 0) diff = 7; // "Friday" said on a Friday → next Friday
        dayOffset = diff;
        break;
      }
    }
  }
  if (dayOffset == null) return null;

  let hour = 9;
  let minute = 0;
  const ampm = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (ampm) {
    hour = parseInt(ampm[1], 10) % 12;
    if (ampm[3] === 'pm') hour += 12;
    minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
  } else {
    const h24 = s.match(/\b(\d{1,2}):(\d{2})\b/);
    if (h24) { hour = parseInt(h24[1], 10); minute = parseInt(h24[2], 10); }
  }

  const startOfDay = t.startOfDayISO(tz, dayOffset, now);
  const offset = startOfDay.slice(-6);
  const datePart = startOfDay.slice(0, 10);
  return `${datePart}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
}

/** Gemini (primary, handles Roman Urdu + English) → Whisper (fallback). */
async function transcribeAudio(buffer, mime) {
  const gemini = require('./geminiTranscribe');
  const voice = require('./voice');
  if (!gemini.enabled() && !voice.enabled()) throw new Error('TRANSCRIPTION_UNAVAILABLE');

  const ct = String(mime || '').split(';')[0].trim();
  let transcript = null;
  if (gemini.enabled()) {
    try { transcript = await gemini.transcribe(buffer, ct); }
    catch (e) { console.warn('[meetingIngest] gemini transcribe failed:', e.message); }
  }
  if (!transcript && voice.enabled()) {
    try { transcript = await voice.transcribe(buffer, { filename: `meeting.${extOfType(mime)}` }); }
    catch (e) { console.warn('[meetingIngest] whisper transcribe failed:', e.message); }
  }
  if (!transcript) throw new Error('TRANSCRIBE_FAILED');
  return transcript;
}

/** Save the raw audio to the user's Google Drive (best-effort). Returns the link
 *  or null. Never throws. */
async function saveRecordingToDrive(user, meeting, buffer, mime) {
  try {
    if (!require('../auth/googleAuth').isConnected(user)) return null;
    const drive = require('./drive');
    const ext = extOfType(mime);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const up = await drive.uploadFile(user, {
      name: `${meeting.title || 'Meeting'} — ${stamp}.${ext}`,
      mimeType: (mime || 'audio/webm').split(';')[0].trim(),
      buffer,
      folderName: 'Wingman Meetings',
    });
    return (up && up.link) || null;
  } catch (e) {
    console.warn('[meetingIngest] drive recording save failed:', e.message);
    return null;
  }
}

/**
 * Turn a meeting's summary action items into real tasks (with reminders). Skips
 * duplicates by title and marks the meeting tasks_created. Returns the created
 * task stubs. Safe to call more than once.
 */
function createTasksFromSummary(user, meeting) {
  const actions = (meeting.summary && Array.isArray(meeting.summary.actions)) ? meeting.summary.actions : [];
  if (!actions.length) return [];
  const tz = user.timezone || 'Asia/Karachi';
  const existing = new Set(
    tasksRepo.listForUser(user.id, { includeCompleted: true, limit: 500 }).map((x) => String(x.title || '').toLowerCase()),
  );
  const created = [];
  for (const a of actions) {
    const title = String(a.task || '').trim();
    if (!title || existing.has(title.toLowerCase())) continue;
    const dueDate = parseDueToISO(a.due, tz);
    const task = tasksRepo.create({ userId: user.id, title, source: 'meeting', priority: priorityNum(a.priority), dueDate });
    created.push({ id: task.id, title, due_date: dueDate });
    existing.add(title.toLowerCase());
  }
  meetingsRepo.update(user.id, meeting.id, { tasksCreated: true });
  return created;
}

/**
 * Turn an existing transcript into the summary + downstream actions (email the
 * user, create tasks). Shared by the audio path and the Recall path (which gets
 * a ready-made transcript). Persists notes + summary on the meeting.
 *
 * @returns {Promise<{meeting, summary, email, tasks}>}
 */
async function processTranscript(user, meeting, transcript, opts = {}) {
  const { emailUser = false, createTasks = false } = opts;
  const clean = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (clean) meetingsRepo.update(user.id, meeting.id, { notes: transcript });

  // Guard: an empty / near-empty transcript (bot never admitted, a silent or
  // cancelled meeting, or corrupted audio) must NOT be turned into a made-up
  // "summary" — that's how a cancelled meeting produced fake action items.
  //
  // Also guard against a FRAGMENT: a full meeting produces a substantial
  // transcript, so too few words means the notetaker only caught a snippet
  // (joined late, half-admitted, poor audio). Summarising a fragment yields a
  // confident but WRONG summary of the whole meeting (the "wrong subject" bug) —
  // far worse in front of a client than an honest "couldn't capture enough".
  const words = clean ? clean.split(/\s+/).filter(Boolean).length : 0;
  if (clean.length < 40 || words < 50) {
    meetingsRepo.update(user.id, meeting.id, { status: 'no-content' });
    return { meeting: meetingsRepo.getForUser(user.id, meeting.id), summary: null, email: null, tasks: [], empty: true };
  }

  // The agenda from the calendar invite, so the summary says which points were
  // closed and which are still open (→ the follow-up agent below).
  const agenda = require('./meetingFollowup').findAgenda(user.id, meeting);
  const summary = await meetingNotes.summarize({ title: meeting.title, attendees: meeting.attendees, notes: transcript, agenda });

  // Even with enough characters, the audio may be silence, filler or garbled
  // (a solo/quiet test, or a bot that only heard the lobby). Trust the model's
  // noContent flag, and back it up: an all-empty summary, or an "overview" that
  // just describes the recording being unreadable, is treated as no content —
  // so we send an honest note instead of emailing invented action items.
  const nothingReal = !summary.overview && !summary.actions.length && !summary.decisions.length
    && !summary.discussion.length && !summary.openQuestions.length && !summary.followUps.length;
  const describesFailure = /\b(corrupt|unreadable|unintelligible|inaudible|could not be (?:captured|documented|transcrib)|no (?:substantive|real|meeting|actual) (?:content|discussion|notes)|no notes were|nothing was (?:said|discussed))\b/i.test(summary.overview || '');
  if (summary.noContent || nothingReal || describesFailure) {
    meetingsRepo.update(user.id, meeting.id, { status: 'no-content' });
    return { meeting: meetingsRepo.getForUser(user.id, meeting.id), summary: null, email: null, tasks: [], empty: true };
  }

  meetingsRepo.update(user.id, meeting.id, { summary, status: 'summary-ready' });

  const fresh = meetingsRepo.getForUser(user.id, meeting.id);
  // Things left open → a proposed follow-up (sent with the notes on WhatsApp);
  // other people's action items → follow-ups Wingman chases.
  require('./meetingFollowup').prepare(user, fresh, summary);

  let email = null;
  if (emailUser) {
    try {
      email = await meetingMailer.sendSummary(user, fresh, summary);
      if (email && email.sent && email.sent.length) {
        meetingsRepo.update(user.id, meeting.id, { emailedAt: new Date().toISOString() });
      }
    } catch (e) {
      console.warn('[meetingIngest] email failed:', e.message);
    }
  }

  let tasks = [];
  if (createTasks) {
    try { tasks = createTasksFromSummary(user, fresh); }
    catch (e) { console.warn('[meetingIngest] task creation failed:', e.message); }
  }

  return { meeting: meetingsRepo.getForUser(user.id, meeting.id), summary, email, tasks };
}

/**
 * Full pipeline for one recording: transcribe → (Drive save) → summary → email →
 * tasks. Both the app's manual upload and the self-hosted bot funnel through here.
 *
 * @returns {Promise<{meeting, transcript, summary, recordingUrl, email, tasks}>}
 */
async function processAudio(user, meeting, buffer, mime, opts = {}) {
  const { emailUser = false, createTasks = false, saveToDrive = true } = opts;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('NO_AUDIO');

  const transcript = await transcribeAudio(buffer, mime);

  let recordingUrl = null;
  if (saveToDrive) {
    recordingUrl = await saveRecordingToDrive(user, meeting, buffer, mime);
    if (recordingUrl) meetingsRepo.update(user.id, meeting.id, { recordingUrl });
  }

  const out = await processTranscript(user, meeting, transcript, { emailUser, createTasks });
  return { ...out, transcript, recordingUrl };
}

/**
 * Build the WhatsApp "notes ready" message the user gets when a meeting wraps:
 * a short briefing (the summary overview) followed by the action items as
 * bullet points — so the gist lands on WhatsApp, not only in the email.
 * Uses WhatsApp markup (*bold*, _italics_). `summary` may be the structured
 * object or a JSON string (as stored on the meeting row).
 */
function formatNotesMessage(meeting, summary) {
  let s = summary;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
  s = s || {};

  const title = (meeting && meeting.title) || 'your meeting';
  const lines = [`📝 Notes are ready for *${title}*`];

  const overview = String(s.overview || '').trim();
  if (overview) lines.push('', `📋 *Briefing*`, overview);

  const actions = Array.isArray(s.actions) ? s.actions.filter((a) => a && a.task) : [];
  if (actions.length) {
    lines.push('', '✅ *Action items*');
    for (const a of actions) {
      const meta = [a.owner, a.due].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
      lines.push(`• ${a.task}${meta ? ` _(${meta})_` : ''}`);
    }
  } else {
    lines.push('', '_No action items came out of this one._');
  }

  const recUrl = (meeting && (meeting.recording_url || meeting.recordingUrl)) || '';
  lines.push('', `I've emailed you the full summary${actions.length ? ' and added these to your Tasks' : ''}.`);
  if (recUrl) lines.push(`🎥 Recording: ${recUrl}`);

  // What's still open + the follow-up Wingman proposes (if the meeting left any).
  try {
    const uid = meeting && meeting.user_id;
    const user = uid ? require('../db/users').getById(uid) : null;
    const fu = user ? require('./meetingFollowup') : null;
    const plan = fu ? fu.forMeeting(uid, meeting.id) : null;
    const extra = plan ? fu.proposalText(user, plan) : '';
    if (extra) lines.push(extra);
  } catch (_) { /* the notes still go out */ }

  return lines.join('\n');
}

module.exports = {
  processAudio,
  processTranscript,
  transcribeAudio,
  saveRecordingToDrive,
  createTasksFromSummary,
  formatNotesMessage,
  parseDueToISO,
  priorityNum,
  extOfType,
};
