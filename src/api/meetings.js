'use strict';

/**
 * Meetings API for the Wingman app. Every route is user-scoped via req.user
 * (attached by attachUserOptional). Notes → Claude summary + action items, with
 * optional email distribution to attendees + the user.
 */

const express = require('express');
const router = express.Router();

const meetingsRepo = require('../db/meetings');
const meetingNotes = require('../services/meetingNotes');
const meetingMailer = require('../services/meetingMailer');
const meetingIngest = require('../services/meetingIngest');

function requireUser(req, res) {
  if (req.user) return req.user;
  res.status(401).json({ error: 'Not signed in' });
  return null;
}

// ── list / get ──────────────────────────────────────────────────────
router.get('/meetings', (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  res.json({ meetings: meetingsRepo.listForUser(u.id, 100) });
});

router.get('/meetings/:id', (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.getForUser(u.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  res.json({ meeting: m });
});

// ── create / update / delete ────────────────────────────────────────
router.post('/meetings', (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const b = req.body || {};
  const m = meetingsRepo.create(u.id, {
    title: b.title,
    type: b.type,
    company: b.company,
    location: b.location,
    virtual: b.virtual,
    attendees: b.attendees,
    notes: b.notes,
    status: b.status,
    meetingAt: b.meetingAt || b.meeting_at,
  });
  res.json({ meeting: m });
});

router.patch('/meetings/:id', (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.update(u.id, req.params.id, req.body || {});
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  res.json({ meeting: m });
});

router.delete('/meetings/:id', (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  res.json({ ok: meetingsRepo.remove(u.id, req.params.id) });
});

// ── finalize: notes → summary + action items (optionally email) ─────
router.post('/meetings/:id/finalize', async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const existing = meetingsRepo.getForUser(u.id, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Meeting not found' });

  // Accept last-minute notes/attendees so the client can save + finalize in one call.
  const b = req.body || {};
  const patch = {};
  if (typeof b.notes === 'string') patch.notes = b.notes;
  if (Array.isArray(b.attendees)) patch.attendees = b.attendees;
  const base = Object.keys(patch).length ? meetingsRepo.update(u.id, existing.id, patch) : existing;

  let summary;
  try {
    const agenda = require('../services/meetingFollowup').findAgenda(u.id, base);
    summary = await meetingNotes.summarize({ title: base.title, attendees: base.attendees, notes: base.notes, agenda });
  } catch (_) {
    return res.status(502).json({ error: 'Could not generate the summary right now' });
  }
  meetingsRepo.update(u.id, base.id, { summary, status: 'summary-ready' });
  const fresh = meetingsRepo.getForUser(u.id, base.id);
  require('../services/meetingFollowup').prepare(u, fresh, summary);

  // Auto-deliver the notes to the user (email + WhatsApp + tasks) as soon as the
  // summary exists, so they're NEVER lost if the app closes before "approve" —
  // same as the notetaker. Only send when there's real content.
  const hasContent = summary && (summary.overview || (summary.actions || []).length
    || (summary.decisions || []).length || (summary.discussion || []).length);
  let email = null;
  if (hasContent) {
    try {
      email = await meetingMailer.sendSummary(u, fresh, summary);
      if (email && email.sent && email.sent.length) meetingsRepo.update(u.id, base.id, { emailedAt: new Date().toISOString() });
    } catch (e) { console.warn('[meetings] finalize email failed:', e.message); }
    try { meetingIngest.createTasksFromSummary(u, fresh); } catch (_) { /* best-effort */ }
    try {
      const wa = require('../whatsapp/client');
      if (wa.ready()) await wa.sendMessage(u.phone, meetingIngest.formatNotesMessage(fresh, summary));
    } catch (_) { /* best-effort */ }
  }
  res.json({ meeting: meetingsRepo.getForUser(u.id, base.id), email });
});

// ── transcribe: audio recording → transcript → summary (+ Drive save) ─────────
router.post('/meetings/:id/transcribe', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.getForUser(u.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });

  const audio = req.body;
  if (!Buffer.isBuffer(audio) || !audio.length) return res.status(400).json({ error: 'No audio received' });

  try {
    // Auto-deliver like the notetaker: email + tasks now, so a recorded meeting is
    // NEVER lost if the app closes before the user taps "approve".
    const out = await meetingIngest.processAudio(u, m, audio, req.headers['content-type'], { saveToDrive: true, emailUser: true, createTasks: true });
    // Also WhatsApp the notes to the user's own number right away. The
    // near-duplicate guard stops a second copy if they also approve in the app.
    try {
      const wa = require('../whatsapp/client');
      if (wa.ready() && out && out.summary) {
        await wa.sendMessage(u.phone, meetingIngest.formatNotesMessage(out.meeting || m, out.summary));
      }
    } catch (_) { /* best-effort */ }
    res.json({ meeting: out.meeting, transcript: out.transcript });
  } catch (e) {
    if (e.message === 'TRANSCRIPTION_UNAVAILABLE') return res.status(501).json({ error: 'Transcription is not available' });
    if (e.message === 'NO_AUDIO') return res.status(400).json({ error: 'No audio received' });
    console.warn('[meetings] transcribe failed:', e.message);
    return res.status(502).json({ error: 'Could not transcribe the recording' });
  }
});

// ── create-tasks: turn the summary's action items into REAL tasks (+reminders) ─
router.post('/meetings/:id/create-tasks', (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.getForUser(u.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  const created = meetingIngest.createTasksFromSummary(u, m);
  res.json({ created: created.length, tasks: created });
});

// ── notify-attendees: send the summary to attendees' WhatsApp numbers ─────────
router.post('/meetings/:id/notify-attendees', async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.getForUser(u.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!m.summary) return res.status(400).json({ error: 'No summary to send yet' });

  const wa = require('../whatsapp/client');
  if (!wa.ready()) return res.status(503).json({ error: 'WhatsApp is not connected' });

  // Build a compact summary message with action items.
  const lines = [`📋 *${m.title || 'Meeting'}*`];
  if (m.summary.overview) lines.push('', m.summary.overview);
  if (Array.isArray(m.summary.actions) && m.summary.actions.length) {
    lines.push('', '*Action items:*');
    for (const a of m.summary.actions) {
      const meta = [a.owner, a.due].filter(Boolean).join(', ');
      lines.push(`• ${a.task}${meta ? ` (${meta})` : ''}`);
    }
  }
  lines.push('', '— via Wingman');
  const body = lines.join('\n');

  const digits = (p) => String(p || '').replace(/[^0-9]/g, '');
  const targets = (m.attendees || []).filter((a) => a && digits(a.phone).length >= 8);
  if (!targets.length) return res.json({ sent: [], failed: [], skipped: 'no_attendee_phones' });

  const sent = [];
  const failed = [];
  for (const a of targets) {
    try {
      await wa.sendMessage(digits(a.phone), body);
      sent.push(a.name || digits(a.phone));
    } catch (err) {
      // WhatsApp only delivers to numbers that messaged the business in the last
      // 24h (unless a template is used), so a fresh attendee will fail here.
      failed.push({ name: a.name || digits(a.phone), reason: err.message });
    }
  }
  res.json({ sent, failed });
});

// ── notify-me: WhatsApp the briefing + action items to the USER themselves ────
//   Same format the notetaker bot sends, so approving "WhatsApp" on a recorded
//   meeting delivers the notes straight to the user's own WhatsApp.
router.post('/meetings/:id/notify-me', async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.getForUser(u.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!m.summary) return res.status(400).json({ error: 'No summary to send yet' });
  if (!u.phone) return res.status(400).json({ error: 'No WhatsApp number on file' });

  const wa = require('../whatsapp/client');
  if (!wa.ready()) return res.status(503).json({ error: 'WhatsApp is not connected' });

  try {
    const msg = meetingIngest.formatNotesMessage(m, m.summary);
    const r = await wa.sendMessage(u.phone, msg);
    res.json({ ok: true, sent: !(r && r.duplicate) });
  } catch (e) {
    console.warn('[meetings] notify-me failed:', e.message);
    res.status(502).json({ error: 'Could not send on WhatsApp' });
  }
});

// ── send: email the stored summary ──────────────────────────────────
router.post('/meetings/:id/send', async (req, res) => {
  const u = requireUser(req, res);
  if (!u) return;
  const m = meetingsRepo.getForUser(u.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!m.summary) return res.status(400).json({ error: 'No summary to send yet' });

  const email = await meetingMailer.sendSummary(u, m, m.summary);
  if (email && email.sent && email.sent.length) {
    meetingsRepo.update(u.id, m.id, { emailedAt: new Date().toISOString() });
  }
  res.json({ email });
});

module.exports = router;
