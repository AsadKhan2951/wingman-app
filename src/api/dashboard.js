'use strict';

/**
 * Dashboard JSON API for the Wingman mobile PWA.
 *
 * Every endpoint tries to read live data for the resolved user from SQLite;
 * if the user has no rows yet (e.g. Google not connected), it falls back to a
 * rich mock dataset so every page looks fully populated for demos/screenshots.
 *
 * User resolution: ?userId=... or the first user in the DB, else the demo user.
 */

const express = require('express');
const router = express.Router();

const mock = require('./mockData');
const usersRepo = require('../db/users');
const config = require('../config');

// ── helpers ──────────────────────────────────────────────────────────
function resolveUser(req) {
  // Only the authenticated user (attached by the auth middleware). We used to
  // also honour ?userId= for "debug tooling", but that let anyone read another
  // user's real emails/calendar/bills/contacts with no token — removed. No auth
  // → null (unauthenticated requests get the mock dataset, never real data).
  return req.user || null;
}

/**
 * Resolve a repo read to { data, mock }.
 * `allowMock` is true only for UNauthenticated requests — a real logged-in user
 * always sees their own live data (empty arrays included), never dummy data.
 */
function safe(fn, fallback, allowMock) {
  try {
    const v = fn();
    if (v == null) return allowMock ? { data: fallback, mock: true } : { data: Array.isArray(fallback) ? [] : null, mock: false };
    if (Array.isArray(v) && v.length === 0) return allowMock ? { data: fallback, mock: true } : { data: [], mock: false };
    return { data: v, mock: false };
  } catch (_) {
    return allowMock ? { data: fallback, mock: true } : { data: Array.isArray(fallback) ? [] : null, mock: false };
  }
}

function requireRepo(name) {
  try { return require(`../db/${name}`); } catch (_) { return null; }
}

// Best-effort real sender photo. Gmail's own photos come from Google's private
// profile service (not in the public API); the public, no-quota way is Gravatar,
// keyed by the sender's email. `d=404` makes it return 404 when there's no photo,
// so the app cleanly falls back to the sender's initials.
function senderAvatar(sender, photoMap) {
  const m = String(sender || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (!m) return null;
  const email = m[0].trim().toLowerCase();
  // Real Google contact photo first (this is what Gmail shows); Gravatar is the
  // public fallback for non-contacts; if neither exists the image 404s and the
  // app renders initials.
  if (photoMap && photoMap[email]) return photoMap[email];
  const hash = require('crypto').createHash('md5').update(email).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=96`;
}

// ── /api/me ──────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const u = resolveUser(req);
  if (!u) return res.json({ ...mock.user, wingman_number: config.wingmanNumber || null, whatsapp_connected: false, mock: true });
  // "Connected" = the user has actually exchanged a message with Wingman on
  // WhatsApp (so the card reassures them the link is live).
  const convo = requireRepo('conversations');
  const whatsappConnected = !!(convo && convo.historyForUser(u.id, 1).length);

  // Real email + Google profile photo, so the header avatar and the profile
  // screen show the actual user. Prefer the primary Google account email; the
  // avatar is fetched once from the OpenID userinfo endpoint and cached.
  // Real email + Google photo, resolved dynamically and SELF-HEALING — so a
  // wrong/blank-email Google account never leaves the profile showing the wrong
  // person (that used to need a manual DB fix per user; now it corrects itself).
  let email = null;
  let avatarUrl = u.avatar_url || null;
  const accountsRepo = require('../db/googleAccounts');
  try {
    const accounts = accountsRepo.listForUser(u.id);
    let primary = accounts.find((a) => a.is_primary) || accounts[0] || null;
    // If the primary account has no email but another linked one does, promote the
    // real one — exactly the "wrong account became primary" case, fixed on the fly.
    if (primary && !primary.email) {
      const withEmail = accounts.find((a) => a.email);
      if (withEmail) { accountsRepo.setPrimary(u.id, withEmail.id); primary = withEmail; }
    }
    if (primary && primary.email) email = primary.email;
  } catch (_) { /* none linked */ }
  if (!email) email = u.webmail_address || null;

  // Fill a missing email/photo from Google, and BACKFILL the email onto the
  // account so a null email is never left behind to confuse the next load.
  if (require('../auth/googleAuth').isConnected(u) && (!avatarUrl || !email)) {
    try {
      const ident = await require('../services/gmail').getIdentity(u);
      if (ident) {
        if (ident.email) {
          if (!email) email = ident.email;
          try {
            const primary = accountsRepo.getPrimary(u.id);
            if (primary && !primary.email) accountsRepo.setEmail(primary.id, ident.email);
          } catch (_) { /* best-effort */ }
        }
        if (ident.picture && ident.picture !== u.avatar_url) {
          avatarUrl = ident.picture;
          usersRepo.update(u.id, { avatar_url: ident.picture });
        }
      }
    } catch (_) { /* best-effort — keep whatever we have */ }
  }

  res.json({
    id: u.id,
    phone: u.phone,
    name: u.name || null,
    email,
    avatar_url: avatarUrl,
    timezone: u.timezone || 'Asia/Karachi',
    work_hours_start: u.work_hours_start,
    work_hours_end: u.work_hours_end,
    language: u.language,
    onboarding_complete: !!u.onboarding_complete,
    briefing_time: u.briefing_time,
    debrief_time: u.debrief_time,
    proactiveness_level: u.proactiveness_level,
    autonomy_level: u.autonomy_level || null,
    runs_business: u.runs_business == null ? null : !!u.runs_business,
    auto_join_meetings: !!((u.preferences || {}).autoJoinMeetings),
    save_meeting_recording: !!((u.preferences || {}).saveMeetingRecording),
    email_context: {
      instructions: (((u.preferences || {}).emailContext) || {}).instructions || '',
      notify: (((u.preferences || {}).emailContext) || {}).notify !== false,
    },
    enabled_skills: u.enabled_skills,
    tone: u.tone,
    communication_style: u.communication_style,
    // Saved home/office (set via /api/places) — the app needs these for the
    // commute widget and leave-by times; they were missing before, so commute
    // never loaded.
    home_address: u.home_address || null,
    office_address: u.office_address || null,
    // Derive "health connected" from real readings, not the dead health_connected
    // column that nothing ever writes (which made a connected user read as not).
    health_connected: (() => {
      try { return require('../db/healthData').hasAnyData(u.id); }
      catch (_) { return !!u.health_connected; }
    })(),
    gmail_connected: require('../auth/googleAuth').isEmailConnected(u),
    calendar_connected: require('../auth/googleAuth').isConnected(u),
    webmail_connected: !!u.webmail_address,
    webmail_address: u.webmail_address || null,
    wingman_number: config.wingmanNumber || null,
    // Lets the app open signed connect links (/auth/google?phone=…&sig=…).
    connect_sig: require('../utils/linkSig').connectSig(u.phone),
    // "Call me for my briefing & wrap" (also turns voice notes on), and whether
    // WhatsApp calling is live on this server yet (else: voice notes only).
    briefing_call: require('../services/briefingCall').isOn(u),
    briefing_calls_available: require('../config').elevenlabs.callsReady,
    voice_notes_available: require('../config').elevenlabs.enabled,
    whatsapp_connected: whatsappConnected,
    created_at: u.created_at || null,
    mock: false,
  });
});

// ── /api/calendar?range=today|tomorrow|week ─────────────────────────
router.get('/calendar', async (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('calendarEvents');
  // Best-effort live sync from Google over a broad window so the dashboard
  // reflects real events — including ones just created via WhatsApp. Falls
  // back to whatever is cached if Google is unreachable / not connected.
  if (u && require('../auth/googleAuth').isConnected(u)) {
    try {
      const calSvc = require('../services/calendar');
      const from = new Date(Date.now() - 7 * 86400000).toISOString();
      const to = new Date(Date.now() + 45 * 86400000).toISOString();
      await calSvc.getEvents(u.id, { from, to });
    } catch (_) { /* keep cached events */ }
  }
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    if (!require('../auth/googleAuth').isConnected(u)) return [];
    return repo.listForUser(u.id);
  }, mock.calendar, !u);
  const norm = data.map((e) => ({
    id: e.id,
    // Google's own event id — the app passes this to /meetings/join so the
    // notetaker bot joins this exact meeting ("Bring Wingman now").
    gcal_event_id: e.gcal_event_id || null,
    title: e.title,
    location: e.location || null,
    start_time: e.start_time,
    end_time: e.end_time,
    attendees: Array.isArray(e.attendees) ? e.attendees
      : (typeof e.attendees === 'string' ? safeParse(e.attendees, []) : []),
    status: e.status || 'confirmed',
    has_conflict: !!e.has_conflict,
    // Video-call link (Meet/Zoom/Teams), so the app can offer "Bring Wingman".
    meeting_url: e.meeting_url || null,
    meeting_provider: e.meeting_provider || null,
  }));
  res.json({ events: norm, mock: isMock });
});

// ── /api/emails ─────────────────────────────────────────────────────
router.get('/emails', async (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('emailItems');
  const gmailConnected = !!(u && require('../auth/googleAuth').isEmailConnected(u));
  const webmailConnected = !!(u && require('../services/webmail').isConnected(u));

  // Pull recent BUSINESS mail into email_items on demand (throttled inside), so it
  // shows right after the user connects — not only after the next 15-min sweep.
  if (webmailConnected) {
    try { await require('../services/webmailInbox').syncUser(u.id); } catch (_) { /* best-effort */ }
  }

  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    // Show the inbox when EITHER Gmail or a business mailbox is connected.
    if (!gmailConnected && !webmailConnected) return [];
    return repo.listForUser(u.id, 100);
  }, mock.emails, !u);
  // Real sender faces from the user's Google contacts (cached). Gmail-parity.
  let photoMap = {};
  if (gmailConnected) {
    try { photoMap = await require('../services/googleContacts').contactPhotoMap(u); }
    catch (_) { /* fall back to Gravatar/initials */ }
  }
  const norm = data.map((e) => ({
    id: e.id,
    sender: e.sender,
    subject: e.subject,
    category: e.category || 'fyi',
    summary: e.summary,
    action_needed: !!e.action_needed,
    replied: !!e.replied,
    detected_type: e.detected_type || 'general',
    draft_reply: e.draft_reply || null,
    // Source tag: business-mailbox rows are keyed webmail:<uid>; everything else
    // is Gmail. Lets the app label each email so the user can tell them apart.
    source: String(e.gmail_id || '').startsWith('webmail:') ? 'webmail' : 'gmail',
    avatar: senderAvatar(e.sender, photoMap),
    account: e.account_email || null,
    received_at: e.received_at || null,
    created_at: e.created_at,
  }));
  res.json({ emails: norm, mock: isMock });
});

// ── /api/emails/:id — open one email (full body, fetched live) ───────
//   Read-only: pulls the real message body from Gmail or the business mailbox so
//   the user can actually READ it in the app. Stored summary is the fallback.
router.get('/emails/:id', async (req, res) => {
  const u = resolveUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  const repo = requireRepo('emailItems');
  const row = repo && repo.getById ? repo.getById(u.id, req.params.id) : null;
  if (!row) return res.status(404).json({ error: 'Email not found' });

  const gid = String(row.gmail_id || '');
  const isWebmail = gid.startsWith('webmail:');
  let body = row.summary || '';
  let sender = row.sender;
  let subject = row.subject;
  try {
    if (isWebmail) {
      const msg = await require('../services/webmail').readMessage(u, gid.slice('webmail:'.length));
      if (msg) { body = msg.body || body; sender = msg.from || sender; subject = msg.subject || subject; }
    } else {
      const account = row.account_id ? require('../db/googleAccounts').getById(row.account_id) : null;
      const msg = await require('../services/gmail').getMessage(u, gid, account);
      if (msg) { body = msg.body || body; sender = msg.sender || sender; subject = msg.subject || subject; }
    }
  } catch (e) {
    console.warn('[emails] body fetch failed:', e.message); // fall back to the stored summary
  }

  res.json({
    id: row.id,
    sender,
    subject,
    body,
    summary: row.summary || '',
    category: row.category || 'fyi',
    source: isWebmail ? 'webmail' : 'gmail',
    created_at: row.created_at,
  });
});

// ── /api/email-context — the user's email priorities (onboarding) ────
//   Free-form text telling the AI which emails matter, plus a notify toggle.
//   The email scanner reads this to decide what to proactively surface.
router.post('/email-context', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const b = req.body || {};
  const instructions = typeof b.instructions === 'string' ? b.instructions.slice(0, 4000) : '';
  const notify = b.notify === undefined ? true : !!b.notify;
  usersRepo.updatePreferences(req.user.id, { emailContext: { instructions, notify } });
  res.json({ email_context: { instructions, notify } });
});

// ── /api/tasks ──────────────────────────────────────────────────────
router.get('/tasks', async (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('tasks');
  if (u) {
    try { await require('../services/googleTasks').syncUser(u.id); } catch (_) { /* keep local copy */ }
  }
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id, { includeCompleted: true, limit: 200 });
  }, mock.tasks, !u);
  const norm = data.map((t) => ({
    id: t.id,
    title: t.title,
    source: t.source || 'manual',
    priority: t.priority != null ? t.priority : 3,
    due_date: t.due_date || null,
    completed: !!t.completed,
    recurring: t.recurring || null,
  }));
  res.json({ tasks: norm, mock: isMock });
});

// ── /api/bills ──────────────────────────────────────────────────────
router.get('/bills', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('bills');
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id);
  }, mock.bills, !u);
  const norm = data.map((b) => ({
    id: b.id, name: b.name, amount: b.amount, currency: b.currency || 'PKR',
    due_date: b.due_date, status: b.status || 'pending', recurring: !!b.recurring,
  }));
  res.json({ bills: norm, mock: isMock });
});

// ── /api/deliveries ─────────────────────────────────────────────────
router.get('/deliveries', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('deliveries');
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id);
  }, mock.deliveries, !u);
  const norm = data.map((d) => ({
    id: d.id, item_name: d.item_name, merchant: d.merchant, carrier: d.carrier,
    tracking_number: d.tracking_number, status: d.status || 'in_transit',
    estimated_delivery: d.estimated_delivery || null, delivered_at: d.delivered_at || null,
    return_window_ends: d.return_window_ends || null,
  }));
  res.json({ deliveries: norm, mock: isMock });
});

// ── /api/travel ─────────────────────────────────────────────────────
router.get('/travel', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('travel');
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id);
  }, mock.travel, !u);
  const norm = data.map((t) => ({
    id: t.id, trip_name: t.trip_name, type: t.type, provider: t.provider,
    confirmation_code: t.confirmation_code, origin: t.origin, destination: t.destination,
    depart_time: t.depart_time, arrive_time: t.arrive_time, return_time: t.return_time || null,
    status: t.status || 'confirmed', price: t.price, currency: t.currency || 'PKR',
    hotel_name: t.hotel_name || null, hotel_checkin: t.hotel_checkin || null, hotel_checkout: t.hotel_checkout || null,
  }));
  res.json({ trips: norm, mock: isMock });
});

// ── /api/health ─────────────────────────────────────────────────────
router.get(['/health-data', '/health'], (req, res) => {
  const u = resolveUser(req);
  // Unauthenticated demo requests see the sample; real users get their actual
  // latest readings (same source the briefing/health analyst reads).
  if (!u) return res.json({ health: mock.health, mock: true });
  try {
    const healthRepo = require('../db/healthData');
    const all = healthRepo.latestAll(u.id);
    const by = Object.fromEntries(all.map((r) => [r.metric_type, r]));
    const num = (m) => (by[m] ? Number(by[m].value) : null);
    let summary = null;
    try { summary = require('../services/health').summaryLine(u.id); } catch (_) { /* optional */ }

    // Per-metric detail for the Health screen: latest value, the user's own
    // recent baseline (their normal), and a short normalised series for a
    // sparkline. All REAL — empty arrays/nulls when there isn't enough history.
    const detail = (metric) => {
      const rows = healthRepo.since(u.id, metric, 9);
      const vals = rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
      let series = [];
      if (vals.length) {
        const recent = vals.slice(-7);
        const max = Math.max(...recent);
        const min = Math.min(...recent);
        const span = max - min || 1;
        series = recent.map((v) => Math.round((((v - min) / span) * 0.8 + 0.2) * 100) / 100);
      }
      let baseline = null;
      try { const b = healthRepo.baseline(u.id, metric); if (b) baseline = Math.round(b.mean * 10) / 10; } catch (_) { /* none */ }
      return { value: num(metric), baseline, series };
    };

    // Sleep over the last 7 nights, for the week chart.
    const week = healthRepo.since(u.id, 'sleep_hours', 8)
      .slice(-7)
      .map((r) => ({ at: r.recorded_at, hours: Number(r.value) }));

    res.json({
      health: {
        connected: all.length > 0,
        sleep_hours: num('sleep_hours'),
        hrv: num('hrv'),
        recovery: num('recovery'),
        resting_heart_rate: num('resting_heart_rate'),
        steps: num('steps'),
        summary,
        reads: {
          sleep_hours: detail('sleep_hours'),
          hrv: detail('hrv'),
          recovery: detail('recovery'),
          resting_heart_rate: detail('resting_heart_rate'),
          steps: detail('steps'),
        },
        week,
      },
      mock: false,
    });
  } catch (e) {
    res.json({ health: { connected: false, sleep_hours: null, hrv: null, steps: null, reads: {}, week: [] }, mock: false });
  }
});

// ── /api/contacts ───────────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  const u = resolveUser(req);
  // Prefer the user's REAL saved Google contacts (People API) — their address
  // book, not everyone they've emailed. Falls back to the CRM if the contacts
  // scope wasn't granted (user connected before it) or Google is unreachable.
  if (u) {
    try {
      const gc = require('../services/googleContacts');
      const list = await gc.listContacts(u);
      if (list && list.length) {
        return res.json({
          contacts: list.map((c, i) => ({
            id: `g-${i}`, name: c.name, email: c.email, company: c.company || null,
            photo: c.photo || null,
            relationship: null, interaction_count: 0, strength: 'saved',
            last_contacted_at: null, notes: null,
          })),
          mock: false, source: 'google',
        });
      }
    } catch (_) { /* fall through to the CRM */ }
  }
  const repo = requireRepo('contacts');
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id);
  }, mock.contacts, !u);
  const norm = data.map((c) => ({
    id: c.id, name: c.name, email: c.email, company: c.company || null,
    relationship: c.relationship || null, interaction_count: c.interaction_count || 0,
    strength: c.strength || 'occasional', last_contacted_at: c.last_contacted_at || null,
    notes: c.notes || c.last_summary || null,
  }));
  res.json({ contacts: norm, mock: isMock });
});

// ── /api/followups ──────────────────────────────────────────────────
router.get('/followups', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('followups');
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id);
  }, mock.followups, !u);
  res.json({ followups: data, mock: isMock });
});

// ── /api/briefings ──────────────────────────────────────────────────
router.get('/briefings', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('briefings');
  const { data, mock: isMock } = safe(() => {
    if (!u || !repo || !repo.listForUser) return null;
    return repo.listForUser(u.id);
  }, mock.briefings, !u);
  res.json({ briefings: data, mock: isMock });
});

// ── /api/dashboard (aggregate for Home) ─────────────────────────────
router.get('/dashboard', async (req, res) => {
  const u = resolveUser(req);
  if (u) {
    try { await require('../services/googleTasks').syncUser(u.id); } catch (_) { /* keep cached tasks */ }
  }

  function pull(name, key, fallback) {
    const repo = requireRepo(name);
    const { data } = safe(() => {
      if (!u || !repo || !repo.listForUser) return null;
      const args = name === 'emailItems' ? [u.id, 100] : [u.id];
      return repo.listForUser(...args);
    }, fallback, !u);
    return data;
  }

  const calendar = pull('calendarEvents', 'events', mock.calendar);
  const emails = pull('emailItems', 'emails', mock.emails);
  const tasks = pull('tasks', 'tasks', mock.tasks);
  const bills = pull('bills', 'bills', mock.bills);
  const deliveries = pull('deliveries', 'deliveries', mock.deliveries);
  const travel = pull('travel', 'trips', mock.travel);

  const now = Date.now();
  const isToday = (d) => {
    if (!d) return false;
    const dt = new Date(d);
    const n = new Date();
    return dt.getFullYear() === n.getFullYear() && dt.getMonth() === n.getMonth() && dt.getDate() === n.getDate();
  };

  const todaysEvents = calendar
    .filter((e) => isToday(e.start_time))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const nextEvent = todaysEvents.find((e) => new Date(e.start_time).getTime() >= now) || todaysEvents[0] || null;

  const urgentCount = emails.filter((e) => e.category === 'urgent').length;
  const needReplyCount = emails.filter((e) => e.category === 'needs_reply').length;

  const tasksDue = tasks.filter((t) => !t.completed);
  const tasksDone = tasks.filter((t) => t.completed).length;

  const pendingBills = bills
    .filter((b) => b.status !== 'paid')
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const nextBill = pendingBills[0] || null;

  const activeDeliveries = deliveries.filter((d) => d.status !== 'delivered');
  const nextTrip = (travel || [])
    .slice()
    .sort((a, b) => new Date(a.depart_time) - new Date(b.depart_time))[0] || null;

  res.json({
    user: { name: u ? (u.name || null) : mock.user.name, timezone: u ? (u.timezone || 'Asia/Karachi') : mock.user.timezone },
    calendar: { count: todaysEvents.length, next: nextEvent ? { title: nextEvent.title, start_time: nextEvent.start_time } : null },
    email: { urgent: urgentCount, need_reply: needReplyCount, total_unread: emails.length },
    tasks: { due: tasksDue.length, done: tasksDone, total: tasks.length },
    bills: { next: nextBill, count: pendingBills.length },
    deliveries: { count: activeDeliveries.length, next: activeDeliveries[0] || null },
    travel: { next: nextTrip },
    health: u ? { sleep_hours: null, hrv: null, steps: null } : { sleep_hours: mock.health.sleep_hours, hrv: mock.health.hrv, steps: mock.health.steps },
  });
});

// ── Mutations (used by swipe gestures; work on live data, no-op on mock) ──
router.post('/tasks/:id/complete', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('tasks');
  try {
    // Only the task's owner may complete it (was unscoped — cross-user write).
    if (u && repo && repo.complete && repo.getById) {
      const task = repo.getById(req.params.id);
      if (task && String(task.user_id) === String(u.id)) {
        repo.complete(req.params.id);
        require('../services/googleTasks').mirrorTaskCompletion(req.params.id).catch(() => {});
      }
    }
  } catch (_) { /* ignore for mock */ }
  res.json({ ok: true, id: req.params.id, completed: true });
});

// Permanently delete a task (done-task cleanup). Also removes it on Google so a
// later sync won't re-import it. Only deletes the caller's own task.
router.delete('/tasks/:id', async (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('tasks');
  try {
    if (u && repo && repo.getById && repo.remove) {
      const task = repo.getById(req.params.id);
      if (task && String(task.user_id) === String(u.id)) {
        try { await require('../services/googleTasks').mirrorTaskDeletion(task); } catch (_) { /* best-effort */ }
        repo.remove(task.id);
      }
    }
  } catch (_) { /* ignore for mock */ }
  res.json({ ok: true, id: req.params.id, deleted: true });
});

router.post('/bills/:id/pay', (req, res) => {
  const u = resolveUser(req);
  const repo = requireRepo('bills');
  try {
    // Only the bill's owner may mark it paid (was unscoped — cross-user write).
    if (u && repo && repo.markPaid && repo.getById) {
      const bill = repo.getById(req.params.id);
      if (bill && String(bill.user_id) === String(u.id)) repo.markPaid(req.params.id);
    }
  } catch (_) { /* ignore for mock */ }
  res.json({ ok: true, id: req.params.id, status: 'paid' });
});

// ── Landing-page waitlist (PUBLIC — the marketing site at imyourwingman.ai posts
//    here). Stores every signup so none is ever lost, and emails the team so a
//    new lead reaches them straight away. ──
const WAITLIST_TO = ['hello@wehearyou.studio', 'aamir@wehearyou.studio', 'fayyazkhanfk57@gmail.com'];
const WAITLIST_FROM = config.waitlist.notifyFrom;
const WAITLIST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The visitor's real IP — behind Caddy the client address is the first entry in
// X-Forwarded-For; fall back to the socket. Strips the IPv6-mapped IPv4 prefix.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || req.ip || (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '') || null;
}

// Best-effort country from an IP (free, no key). Never throws; null on any issue.
async function ipCountry(ip) {
  if (!ip) return null;
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country_name/`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const t = (await res.text()).trim();
    return (t && t.length < 60 && !/error|reserved|undefined|not found/i.test(t)) ? t : null;
  } catch (_) { return null; }
}

router.post('/home/notify', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const company = String(b.company || '').trim(); // honeypot — humans leave it blank
  // Optional first name for the thank-you greeting ("Hi Aamir,"). Cleaned and
  // validated in one place; junk becomes null and the email says "Hi there,".
  const firstName = require('../services/waitlistThankYou').cleanFirstName(b.name || b.firstName || b.first_name);

  // A bot that filled the honeypot gets the same success a human sees, but we do
  // nothing with it (mirrors the landing form's own comment).
  if (company) return res.json({ ok: true });
  if (!WAITLIST_EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }

  // 1) Persist first — a signup must never be lost even if email delivery fails.
  //    Also capture the visitor's IP (boss wants to know which country signups
  //    come from); the country is filled in best-effort just after, from the IP.
  const ip = clientIp(req);
  let isNewSignup = false;
  try {
    // Table + columns (ip, country, thankyou_sent_at, unsubscribed_at) — idempotent.
    const db = require('../services/waitlistThankYou').ensureTable();
    const ins = db.prepare('INSERT OR IGNORE INTO waitlist (email, ip, first_name) VALUES (?, ?, ?)').run(email, ip, firstName);
    isNewSignup = ins.changes === 1;
    // Someone re-submitting with a name we didn't have yet — keep it.
    if (!isNewSignup && firstName) db.prepare('UPDATE waitlist SET first_name = COALESCE(first_name, ?) WHERE email = ?').run(firstName, email);
    // Fill the IP if this email was stored before the column existed.
    if (ip) db.prepare('UPDATE waitlist SET ip = COALESCE(ip, ?) WHERE email = ?').run(ip, email);
  } catch (e) { console.warn('[waitlist] store failed:', e.message); }

  // Thank-you email to the person who just joined (thank-you-v1). Only for a
  // NEW signup, and sendOnce() also guards per address, so a double-submit never
  // sends twice. Fire-and-forget: it can never delay or fail the signup.
  if (isNewSignup) {
    try {
      require('../services/waitlistThankYou').sendOnce(email)
        .then((r) => { if (r && r.error) console.warn('[waitlist] thank-you failed:', r.error); })
        .catch((e) => console.warn('[waitlist] thank-you failed:', e.message));
    } catch (e) { console.warn('[waitlist] thank-you failed:', e.message); }
  }

  // Mirror into the boss's live Google Sheet — the moment a lead arrives. Sent
  // right away with what we have (email + IP); the country fills into the SAME
  // row a few seconds later (the sheet upserts by email). Fire-and-forget: it can
  // never delay or fail the signup.
  try {
    const waitlistSheet = require('../services/waitlistSheet');
    if (waitlistSheet.enabled()) {
      waitlistSheet.pushRow({ email, ip, created_at: new Date().toISOString() })
        .then((r) => { if (!r.ok) console.warn('[waitlist] sheet push failed:', r.error); })
        .catch(() => {});
    }
  } catch (_) { /* best-effort */ }

  // Country from the IP — best-effort and AFTER the response path, so it can never
  // delay or fail the signup. Written onto the row when it resolves.
  if (ip) {
    ipCountry(ip).then((country) => {
      if (!country) return;
      try { const { db } = require('../db'); db.prepare('UPDATE waitlist SET country = ? WHERE email = ?').run(country, email); }
      catch (_) { /* best-effort */ }
      // Update the sheet row now that we know the country.
      try {
        const waitlistSheet = require('../services/waitlistSheet');
        if (waitlistSheet.enabled()) waitlistSheet.pushRow({ email, ip, country }).catch(() => {});
      } catch (_) { /* best-effort */ }
    }).catch(() => {});
  }

  // 2) Notify the team by email (best-effort, via Brevo over HTTPS — SMTP is
  //    blocked in prod). One message per recipient; a failure to one never
  //    blocks the others or the user's success response.
  try {
    const brevo = require('../services/brevo');
    if (brevo.enabled()) {
      const subject = `New Wingman waitlist signup: ${email}`;
      const text = `A new person joined the Wingman waitlist.\n\nEmail: ${email}\nWhen:  ${new Date().toISOString()}\nFrom:  imyourwingman.ai`;
      for (const to of WAITLIST_TO) {
        try {
          await brevo.sendEmail({ from: WAITLIST_FROM, fromName: 'Wingman Waitlist', to, subject, text, replyTo: email });
        } catch (e) { console.warn(`[waitlist] email to ${to} failed:`, e.message); }
      }
    } else {
      console.warn('[waitlist] BREVO_API_KEY not set — signup stored but not emailed:', email);
    }
  } catch (e) { console.warn('[waitlist] notify failed:', e.message); }

  res.json({ ok: true });
});

// ── Unsubscribe from waitlist emails (PUBLIC, link in the thank-you email). ──
//   GET  shows a confirm button — link scanners (Outlook Safe Links, Gmail
//        previews) follow GETs, so a GET alone must never unsubscribe anyone.
//   POST unsubscribes. Also the RFC 8058 one-click target for the
//        List-Unsubscribe-Post header (mail providers POST to the same URL).
//   The token is an HMAC of the address, so nobody can unsubscribe someone else.
function unsubPage(title, body, form) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Wingman</title><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;color:#1c1b1a">' +
    `<h1 style="font-weight:500">${title}</h1><p>${body}</p>${form || ''}</body>`;
}
function unsubParams(req) {
  const email = String((req.query && req.query.e) || '').trim().toLowerCase();
  const token = String((req.query && req.query.t) || '');
  return { email, token };
}
router.get('/waitlist/unsubscribe', (req, res) => {
  const { email, token } = unsubParams(req);
  const tu = require('../services/waitlistThankYou');
  if (!email || !tu.verify(email, token)) {
    return res.status(400).type('html').send(unsubPage('Link not valid', 'This unsubscribe link is incomplete or has expired. Reply to any of our emails and we will take you off the list.'));
  }
  // Re-post to the same URL (query string carries e + t). No user input is
  // echoed into the page.
  const action = `/api/waitlist/unsubscribe?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  res.type('html').send(unsubPage(
    'Unsubscribe from Wingman emails?',
    'You will stop getting waitlist emails from us.',
    `<form method="post" action="${action.replace(/"/g, '&quot;')}"><button type="submit" style="font:inherit;padding:12px 28px;border:0;border-radius:999px;background:#4a6fd4;color:#fff;cursor:pointer">Unsubscribe</button></form>`,
  ));
});
router.post('/waitlist/unsubscribe', (req, res) => {
  const { email, token } = unsubParams(req);
  const tu = require('../services/waitlistThankYou');
  if (!email || !tu.verify(email, token)) {
    return res.status(400).type('html').send(unsubPage('Link not valid', 'This unsubscribe link is incomplete or has expired.'));
  }
  try { tu.unsubscribe(email); } catch (e) {
    console.warn('[waitlist] unsubscribe failed:', e.message);
    return res.status(500).type('html').send(unsubPage('Something went wrong', 'Please try again, or reply to our email and we will remove you.'));
  }
  console.log('[waitlist] unsubscribed:', email);
  res.type('html').send(unsubPage('You are unsubscribed', 'You will not get any more waitlist emails from Wingman.'));
});

// ── Send the thank-you to signups who never got one (admin-only). ──
//   For people who joined BEFORE this email existed. Dry run by default:
//     GET  /api/admin/waitlist/send-thankyou            → how many would get it
//     POST /api/admin/waitlist/send-thankyou?confirm=1  → actually send
//   Admin key in the X-Admin-Key header (not the URL, so it stays out of logs).
//   Fails closed if ADMIN_PASSWORD is unset. Each address still goes through
//   sendOnce(), so nobody is ever emailed twice and unsubscribes are respected.
function adminKeyOk(req) {
  const admin = String(config.adminPassword || '');
  const given = String(req.headers['x-admin-key'] || '');
  if (!admin || !given || admin.length !== given.length) return false;
  return require('crypto').timingSafeEqual(Buffer.from(admin), Buffer.from(given));
}
let thankYouBackfillRunning = false;
router.all('/admin/waitlist/send-thankyou', async (req, res) => {
  if (!adminKeyOk(req)) return res.status(403).json({ error: 'forbidden' });
  const tu = require('../services/waitlistThankYou');
  if (!tu.enabled()) return res.status(400).json({ ok: false, error: 'Thank-you email is off (needs BREVO_API_KEY, and WAITLIST_THANKYOU not 0).' });
  const pending = tu.pendingRecipients(1000);
  const doSend = req.method === 'POST' && req.query.confirm === '1';
  if (!doSend) return res.json({ ok: true, dryRun: true, wouldSend: pending.length, sample: pending.slice(0, 5).map((r) => r.email) });
  if (thankYouBackfillRunning) return res.status(409).json({ ok: false, error: 'A backfill is already running.' });
  thankYouBackfillRunning = true;
  let sent = 0; let skipped = 0; const failed = [];
  try {
    for (const row of pending) {
      const r = await tu.sendOnce(row.email);
      if (r.sent) sent++; else if (r.error) failed.push({ email: row.email, error: r.error }); else skipped++;
      await new Promise((ok) => setTimeout(ok, 300)); // stay well under Brevo rate limits
    }
  } finally { thankYouBackfillRunning = false; }
  res.json({ ok: failed.length === 0, sent, skipped, failed });
});

// ── Backfill the Google Sheet with every stored signup (admin-only). ──
//   Run once after wiring up the sheet so the rows collected before it existed
//   show up too. Safe to re-run — the Apps Script upserts by email. Guarded by
//   ADMIN_PASSWORD: POST (or GET) /api/admin/waitlist/sync-sheet?key=<ADMIN_PASSWORD>
router.all('/admin/waitlist/sync-sheet', async (req, res) => {
  if (!require('../utils/adminAuth').isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const waitlistSheet = require('../services/waitlistSheet');
    if (!waitlistSheet.enabled()) {
      return res.status(400).json({ ok: false, error: 'WAITLIST_SHEET_WEBHOOK_URL is not set on the server.' });
    }
    const result = await waitlistSheet.syncAllFromDb();
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/me — update profile / settings (auth required) ─────────
//   Accepts a whitelisted subset of user fields (name, timezone, work hours,
//   briefing/debrief times, proactiveness_level, enabled_skills, tone,
//   communication_style, language). Requires an authenticated session.
const SETTINGS_FIELDS = [
  'name', 'timezone', 'work_hours_start', 'work_hours_end', 'language',
  'briefing_time', 'debrief_time', 'proactiveness_level', 'enabled_skills',
  'autonomy_level', 'quiet_hours_start', 'quiet_hours_end', 'runs_business',
  'tone', 'communication_style',
  'news_topics', 'news_city', 'news_country', 'voice_replies', 'voice_name', 'assistant_name',
];

// ── POST /api/account/delete  { confirm: 'DELETE' } ─────────────────
//   In-app account deletion (App Store guideline 5.1.1(v)). Removes the user
//   and everything stored for them: messages, memory, connected-account tokens,
//   synced mail/calendar/tasks, meetings, images and sessions. Connected
//   Composio apps are disconnected best-effort first.
router.post('/account/delete', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (String((req.body || {}).confirm || '') !== 'DELETE') {
    return res.status(400).json({ error: 'Send { "confirm": "DELETE" } to delete the account.' });
  }
  const user = req.user;
  try {
    try {
      const composio = require('../services/composio');
      if (config.composio.enabled) {
        const apps = await composio.listConnections(user, { fresh: true });
        for (const a of apps) { try { await composio.disconnect(user, a.toolkit); } catch (_) { /* best-effort */ } }
      }
    } catch (e) { console.warn('[account/delete] composio disconnect skipped:', e.message); }
    try { require('../services/mediaStore').removeAllFor(user.id); } catch (_) { /* best-effort */ }
    try { require('../db').db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(user.phone); } catch (_) { /* best-effort */ }
    usersRepo.deleteUserCascade(user.id);
    console.log(`[account/delete] deleted user ${user.id}`);
    res.json({ deleted: true });
  } catch (e) {
    console.error('[account/delete] failed:', e.message);
    res.status(500).json({ error: 'Could not delete the account. Please contact us.' });
  }
});

router.patch(['/me', '/settings'], (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const body = req.body || {};
  // Briefing calls + voice notes live in preferences, not a column.
  if (body.briefing_call !== undefined) {
    const out = require('../services/briefingCall').setEnabled(req.user.id, !!body.briefing_call);
    const rest = Object.keys(body).filter((k) => k !== 'briefing_call' && SETTINGS_FIELDS.includes(k));
    if (!rest.length) return res.json({ user: usersRepo.toPublic(usersRepo.getById(req.user.id)), ...out });
  }
  const patch = {};
  for (const k of SETTINGS_FIELDS) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided.' });
  }
  const updated = usersRepo.update(req.user.id, patch);
  res.json({ user: usersRepo.toPublic(updated) });
});

// ── POST /api/onboarding/complete — finish the wizard (auth required) ─
//   Optionally accepts the full settings payload to persist in one shot.
router.post('/onboarding/complete', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const body = req.body || {};
  const patch = {};
  for (const k of SETTINGS_FIELDS) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  patch.onboarding_complete = 1;
  const updated = usersRepo.update(req.user.id, patch);
  res.json({ user: usersRepo.toPublic(updated) });
});

// ── Health ───────────────────────────────────────────────────────────
//   Apple Health / Health Connect are on-device only, so instead of an OAuth
//   flow each user gets a private URL that a phone automation posts readings to.
router.get('/health/connect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const health = require('../services/health');
  const healthRepo = require('../db/healthData');
  res.json({
    ingest_url: `${config.publicBaseUrl}/health/ingest/${health.tokenFor(req.user.id)}`,
    connected: healthRepo.hasAnyData(req.user.id),
    metrics: Object.entries(healthRepo.METRICS).map(([k, v]) => ({ metric: k, label: v.label, unit: v.unit })),
  });
});

/**
 * Capture the user's current location from the app (browser geolocation).
 * A web app can only read this while it's open, so we store the LAST KNOWN
 * position and refresh it whenever the app is opened; traffic requests use it
 * as the "current" origin.
 */
router.post('/location', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const lat = Number((req.body || {}).lat);
  const lng = Number((req.body || {}).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Valid lat and lng are required.' });
  }
  try {
    // Reverse-geocode for a readable label when Maps is configured; the raw
    // coordinates are stored regardless so traffic still works without it.
    let label = null;
    if (config.maps.enabled) {
      try { ({ label } = await require('../services/maps').setCurrentLocation(req.user.id, { lat, lng })); }
      catch (_) { /* fall through to storing coords only */ }
    }
    if (label == null) {
      usersRepo.update(req.user.id, {
        current_lat: lat, current_lng: lng, current_location_at: new Date().toISOString(),
      });
    }
    res.json({ ok: true, label });
  } catch (err) {
    console.error('[location] save failed:', err.message);
    res.status(500).json({ error: 'Could not save location.' });
  }
});

/**
 * Reverse-geocode coordinates into a full address, so the app can offer a
 * "use my current location" button that fills in the home/office field.
 */
router.post('/location/reverse', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (!config.maps.enabled) return res.status(503).json({ error: 'Maps is not configured on the server yet.' });
  const lat = Number((req.body || {}).lat);
  const lng = Number((req.body || {}).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Valid lat and lng are required.' });
  try {
    const address = await require('../services/maps').reverseGeocodeAddress(lat, lng);
    if (!address) return res.status(404).json({ error: 'Could not resolve that location to an address.' });
    res.json({ address });
  } catch (err) {
    res.status(500).json({ error: 'Could not look up that location.' });
  }
});

/**
 * Google Health — the one-click path (Android, Pixel Watch, Fitbit, Wear OS).
 * Returns the consent URL rather than redirecting, so the SPA can open it.
 */
router.get('/health/google', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const googleAuth = require('../auth/googleAuth');
  const phone = String(req.user.phone || '').replace(/[^0-9]/g, '');
  res.json({
    connected: googleAuth.isHealthConnected(req.user),
    last_synced_at: req.user.google_health_synced_at || null,
    connect_url: `${config.publicBaseUrl}/auth/google/health?${require('../utils/linkSig').connectQuery(phone)}`,
  });
});

/** Pull now, so the user isn't left staring at an empty screen after connecting. */
router.post('/health/google/sync', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const r = await require('../services/googleHealth').syncUser(req.user.id, { days: 14 });
    if (r.errors && r.errors.includes('NOT_CONNECTED')) {
      return res.status(400).json({ error: 'Google Health is not connected yet.' });
    }
    res.json({ ok: true, saved: r.saved, skipped: r.skipped, errors: r.errors });
  } catch (err) {
    console.error('[health] google sync failed:', err.message);
    res.status(500).json({ error: 'Could not sync from Google Health.' });
  }
});

/** Every wearable brand, with where this user stands on each. */
router.get('/health/wearables', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  res.json({ providers: require('../services/wearables').statusFor(req.user) });
});

router.post('/health/wearables/:provider/sync', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const r = await require('../services/wearables').syncOne(req.user.id, req.params.provider, { days: 14 });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, saved: r.saved });
});

router.post('/health/wearables/:provider/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  require('../services/wearables').disconnect(req.user.id, req.params.provider);
  res.json({ ok: true });
});

router.post('/health/google/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  require('../auth/googleAuth').disconnectHealth(req.user.id);
  res.json({ ok: true, connected: false });
});

/** Rotate the link (old one stops working immediately). */
router.post('/health/reset-link', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const health = require('../services/health');
  health.revokeToken(req.user.id);
  res.json({ ingest_url: `${config.publicBaseUrl}/health/ingest/${health.tokenFor(req.user.id)}` });
});

// ── Work clock (attendance / HRMS webhook) ───────────────────────────
//   The user's attendance system posts clock-in / clock-out to a private URL,
//   so Wingman can catch a forgotten clock-out. Same shape as health: a token
//   in the URL, because the sending system has no session of its own.
router.get('/work/connect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const work = require('../services/work');
  const sessionsRepo = require('../db/workSessions');
  res.json({
    webhook_url: `${config.publicBaseUrl}/work/event/${work.tokenFor(req.user.id)}`,
    connected: sessionsRepo.hasAnyData(req.user.id),
    status: work.status(req.user.id),
    // Outbound side: configured or not, and where to — never the secret.
    action_configured: work.hasAction(req.user),
    action_url: req.user.work_action_url || null,
    employee_ref: req.user.work_employee_ref || null,
    // One-tap NOW HRMS connector: whether the server offers it, and this user's
    // link status. The app leads with this so an employee just enters their email.
    nowhrms: work.nowHrmsStatus(req.user),
  });
});

/**
 * One-tap NOW HRMS connect: the employee sends ONLY their company email. The
 * endpoint URL + shared secret come from server config, so nothing technical is
 * typed. This is the whole per-user step for the first-class connector.
 */
router.post('/work/nowhrms/connect', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const work = require('../services/work');
  const r = await work.connectNowHrms(req.user.id, (req.body || {}).email);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, connected: true, email: (req.body || {}).email });
});

router.post('/work/nowhrms/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const work = require('../services/work');
  work.clearAction(req.user.id);
  res.json({ ok: true, connected: false });
});

/**
 * Configure the other direction: where Wingman should POST when the user says
 * "clock me out". The secret is encrypted at rest and never returned.
 */
router.post('/work/action', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const work = require('../services/work');
  const b = req.body || {};

  if (b.disconnect) {
    work.clearAction(req.user.id);
    return res.json({ ok: true, configured: false });
  }

  const r = await work.setAction(req.user.id, {
    url: b.url,
    secret: b.secret,
    employeeRef: b.employee_ref || null,
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, configured: true, url: r.url });
});

/** Fire a real clock event to check the endpoint actually works. */
router.post('/work/action/test', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const work = require('../services/work');
  const event = req.body && req.body.event === 'clock_in' ? 'clock_in' : 'clock_out';
  const r = await work.performClock(req.user.id, event);
  if (!r.ok) return res.status(400).json({ error: r.detail || r.error, code: r.error });
  res.json({ ok: true, event: r.event, at: r.at });
});

/** Rotate the link (old one stops working immediately). */
router.post('/work/reset-link', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const work = require('../services/work');
  work.revokeToken(req.user.id);
  res.json({ webhook_url: `${config.publicBaseUrl}/work/event/${work.tokenFor(req.user.id)}` });
});

// ── Webmail (IMAP/SMTP business email) ───────────────────────────────
//   Credentials are verified against the real servers BEFORE being stored, and
//   the password is encrypted at rest — it is never returned by any endpoint.
router.post('/webmail/connect', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const b = req.body || {};
  const address = String(b.address || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!address || !password) return res.status(400).json({ error: 'Email address and password are required.' });

  const webmail = require('../services/webmail');
  const secrets = require('../utils/secrets');
  if (!secrets.available()) {
    return res.status(503).json({ error: 'Secure storage is not configured on the server, so we cannot save mail credentials yet.' });
  }

  const guess = webmail.detectSettings(address) || {};
  const cfg = {
    address,
    password,
    imapHost: String(b.imap_host || guess.imapHost || '').trim(),
    imapPort: Number(b.imap_port || guess.imapPort || 993),
    smtpHost: String(b.smtp_host || guess.smtpHost || '').trim(),
    smtpPort: Number(b.smtp_port || guess.smtpPort || 465),
    fromName: String(b.from_name || '').trim() || null,
  };
  if (!cfg.imapHost || !cfg.smtpHost) {
    return res.status(400).json({ error: 'Could not work out the mail server for that address — please enter the IMAP and SMTP hosts.' });
  }

  let capability;
  try {
    capability = await webmail.testConnection(cfg);
  } catch (err) {
    const raw = String(err.message || '');
    // Log the real thing: the generic fallback below tells the user to "check
    // the details" for faults that have nothing to do with what they typed.
    console.error('[webmail] connect failed:', raw);

    const map = {
      WEBMAIL_AUTH_FAILED: 'The email address or password was rejected. If your provider uses 2-factor login, create an app password and use that.',
      WEBMAIL_HOST_NOT_FOUND: `Could not reach the mail server. Check the ${raw.startsWith('IMAP') ? 'IMAP' : 'SMTP'} host.`,
      WEBMAIL_CONNECTION_FAILED: 'The mail server did not respond. Check the host and port.',
    };
    const code = raw.split(':')[1] || raw;
    if (map[code]) return res.status(400).json({ error: map[code] });

    // Unmapped: show what the mail server actually said, rather than implying
    // the user mistyped something.
    const detail = raw.replace(/^IMAP:|^SMTP:/, '').trim();
    return res.status(400).json({
      error: `Could not connect to that mailbox — the mail server said: ${detail || 'no reason given'}`,
    });
  }

  webmail.saveForUser(req.user.id, cfg);
  res.json({
    connected: true,
    address,
    imap_host: cfg.imapHost,
    smtp_host: cfg.smtpHost,
    can_send: capability.canSend,
    // Said plainly so nobody discovers mid-reply that sending was never possible.
    send_note: capability.canSend
      ? null
      : 'Reading works. Sending is blocked by this server\'s host, so replies cannot go out from this address yet.',
  });
});

router.post('/webmail/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  require('../services/webmail').disconnect(req.user.id);
  res.json({ connected: false });
});

/** Suggested IMAP/SMTP settings for an address, so the form can pre-fill. */
router.get('/webmail/detect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const d = require('../services/webmail').detectSettings(req.query.address);
  if (!d) return res.status(400).json({ error: 'Enter a full email address.' });
  res.json(d);
});

// ── POST /api/places — save home / office (geocoded) ─────────────────
//   Goes through Maps so we store real coordinates, which is what the traffic
//   and leave-by calculations need. A bad address is rejected up front.
router.post('/places', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const which = String((req.body || {}).which || '').toLowerCase();
  const address = String((req.body || {}).address || '').trim();
  if (which !== 'home' && which !== 'office') {
    return res.status(400).json({ error: 'which must be "home" or "office".' });
  }
  if (!address) return res.status(400).json({ error: 'An address is required.' });

  try {
    const maps = require('../services/maps');
    const geo = await maps.savePlace(req.user.id, which, address);
    if (!geo) return res.status(400).json({ error: `Could not save "${address}". Please try again.` });
    res.json({
      saved: true,
      which,
      address: geo.address,
      geocoded: geo.geocoded,
      // Saved either way; only precise traffic timing needs the coordinates.
      note: geo.geocoded ? null : 'Saved. Traffic timing for this place is limited until the map lookup is working.',
    });
  } catch (err) {
    const msg = (err && err.message) || '';
    // Collapsing every failure into "could not look up that address" blamed the
    // user's typing for what is usually a key or billing problem on our side.
    console.error('[places] lookup failed:', msg);

    if (msg === 'MAPS_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Traffic features are not switched on yet — no Maps API key is configured.' });
    }
    if (msg === 'MAPS_REQUEST_DENIED') {
      return res.status(503).json({
        error: 'Google rejected the map lookup. The Maps API key is missing, restricted, or the Geocoding API is not enabled for it.',
      });
    }
    if (msg === 'MAPS_QUOTA_EXCEEDED') {
      return res.status(503).json({ error: "Google's map quota is used up for now — try again later." });
    }
    res.status(400).json({ error: `Could not look up that address (${msg || 'unknown error'}).` });
  }
});

// ── Google accounts (multi-account) ──────────────────────────────────
//   The PRIMARY account is mirrored into the legacy users.*_token columns so
//   every existing feature keeps working; this keeps that mirror correct after
//   a disconnect or a primary switch.
function syncPrimaryToLegacy(userId) {
  const accountsRepo = require('../db/googleAccounts');
  const next = accountsRepo.getPrimary(userId);
  if (next) {
    usersRepo.update(userId, { calendar_token: next.token, gmail_token: next.token });
  } else {
    usersRepo.update(userId, { calendar_token: null, gmail_token: null });
  }
  return next || null;
}

/** GET /api/google/accounts — linked accounts, backfilling any missing email. */
router.get('/google/accounts', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const accountsRepo = require('../db/googleAccounts');
  let accounts = accountsRepo.listForUser(req.user.id);

  // Accounts linked before the identity scope existed have no email yet — try
  // to resolve it once so the UI can label them properly.
  for (const a of accounts) {
    if (a.email) continue;
    try {
      const googleAuth = require('../auth/googleAuth');
      const client = googleAuth.getAuthorizedClient(req.user, 'gmail', a);
      const email = await googleAuth.fetchAccountEmail(client);
      if (email) accountsRepo.setEmail(a.id, email);
    } catch (_) { /* leave unlabelled */ }
  }
  accounts = accountsRepo.listForUser(req.user.id);

  res.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      is_primary: !!a.is_primary,
      connected_at: a.created_at,
    })),
  });
});

/** POST /api/google/accounts/:id/disconnect — unlink one account. */
router.post('/google/accounts/:id/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const accountsRepo = require('../db/googleAccounts');
  const cleanup = require('../services/googleDisconnectCleanup');
  const account = accountsRepo.getById(req.params.id);
  if (!account || account.user_id !== req.user.id) return res.status(404).json({ error: 'Account not found.' });
  const result = accountsRepo.remove(req.user.id, req.params.id);
  if (!result.removed) return res.status(404).json({ error: 'Account not found.' });
  syncPrimaryToLegacy(req.user.id);
  const accounts = accountsRepo.listForUser(req.user.id);
  const cleanupResult = accounts.length
    ? cleanup.cleanupAccount(req.user.id, account)
    : cleanup.cleanupAllGoogleData(req.user.id);
  if (accounts.length) cleanup.resyncPrimaryData(req.user.id).catch(() => {});
  res.json({
    cleanup: cleanupResult,
    accounts: accounts.map((a) => ({ id: a.id, email: a.email, is_primary: !!a.is_primary, connected_at: a.created_at })),
  });
});

/** POST /api/google/accounts/:id/primary — choose which account sends/creates. */
router.post('/google/accounts/:id/primary', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const accountsRepo = require('../db/googleAccounts');
  const cleanup = require('../services/googleDisconnectCleanup');
  const acct = accountsRepo.getById(req.params.id);
  // Scope to the caller — never let one user re-primary/clear another's accounts.
  if (!acct || acct.user_id !== req.user.id) return res.status(404).json({ error: 'Account not found.' });
  accountsRepo.setPrimary(req.user.id, req.params.id);
  syncPrimaryToLegacy(req.user.id);
  const cleanupResult = cleanup.cleanupAllGoogleData(req.user.id);
  cleanup.resyncPrimaryData(req.user.id).catch(() => {});
  const accounts = accountsRepo.listForUser(req.user.id);
  res.json({
    cleanup: cleanupResult,
    accounts: accounts.map((a) => ({ id: a.id, email: a.email, is_primary: !!a.is_primary, connected_at: a.created_at })),
  });
});

// ── POST /api/shopify/connect — link a store (auth required) ─────────
//   Verifies the domain + Admin API token against Shopify before saving, so a
//   bad credential is rejected up front rather than failing later in chat.
router.post('/shopify/connect', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  const body = req.body || {};
  const domain = String(body.domain || '').trim();
  const token = String(body.token || '').trim();
  if (!domain || !token) {
    return res.status(400).json({ error: 'Store domain and Admin API token are required.' });
  }
  try {
    const shopify = require('../services/shopify');
    const info = await shopify.testConnection(domain, token);
    usersRepo.update(req.user.id, { shopify_domain: info.domain, shopify_token: token });
    res.json({ connected: true, shop: info.shop, domain: info.domain, currency: info.currency });
  } catch (err) {
    const map = {
      SHOPIFY_AUTH_FAILED: 'Could not connect — check the Admin API access token.',
      SHOPIFY_NOT_FOUND: 'Store not found — check the domain (e.g. mystore.myshopify.com).',
    };
    res.status(400).json({ error: map[err.message] || 'Could not reach that store. Please check the details and try again.' });
  }
});

// ── POST /api/shopify/disconnect ─────────────────────────────────────
router.post('/shopify/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  usersRepo.update(req.user.id, { shopify_domain: null, shopify_token: null });
  res.json({ connected: false });
});

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

module.exports = router;
