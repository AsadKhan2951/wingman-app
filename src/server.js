'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config');
const { initSchema } = require('./db');
const conversations = require('./db/conversations');
const wa = require('./whatsapp/client');
const { isAdmin, requireAdmin } = require('./utils/adminAuth');
const cloudApi = require('./whatsapp/cloudApi');
const engine = require('./engine/conversation');
const authRoutes = require('./auth/routes');
const otpAuthRoutes = require('./api/authRoutes');
const { attachUserOptional } = require('./api/middleware/auth');
const dashboardApi = require('./api/dashboard');
const meetingsApi = require('./api/meetings');
const meetingBotApi = require('./api/meetingBot');
const assistantApi = require('./api/assistant');
const integrationsApi = require('./api/integrations');
const adminQr = require('./admin/qr');
const fs = require('fs');
const path = require('path');
const documentReader = require('./services/documentReader');

const app = express();
app.use(cors());
// Keep the raw bytes: the WhatsApp webhook signature (X-Hub-Signature-256) is
// computed over the exact body Meta sent.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { if (req.originalUrl && req.originalUrl.startsWith('/webhook')) req.rawBody = buf; },
}));

// Google OAuth routes (/auth/google, /auth/google/callback)
app.use('/', authRoutes);

// Phone + OTP auth (unauthenticated: request/verify OTP, logout, me)
app.use('/api/auth', otpAuthRoutes);

// Soft auth: attach req.user when a valid session token is present, but let
// unauthenticated requests through so the rich mock dataset still serves
// investor screenshots in dev. Handlers scope to req.user when available.
app.use('/api', attachUserOptional);

// Dashboard JSON API for the mobile PWA (/api/*)
app.use('/api', dashboardApi);
app.use('/api', meetingsApi);
app.use('/api', meetingBotApi);
app.use('/api', assistantApi);
app.use('/api', integrationsApi.router);
// Composio post-login landing page (/auth/* is proxied on the root domain too)
app.use('/', integrationsApi.callbackRouter);

// Email images (waitlist thank-you etc.) — referenced by absolute URL from
// emails, so they must be public, stable and fast. Only /email/v1/* is served
// here; anything else under /email falls through to the app as before.
app.use('/email/v1', express.static(path.join(__dirname, 'assets', 'email', 'v1'), {
  maxAge: '30d',
  index: false,
  fallthrough: true,
}));

// Images Wingman generated or users sent in — public (unguessable UUID names)
// because Facebook/Instagram fetch a post's photo by URL.
app.use('/media', express.static(config.media.dir, {
  maxAge: '7d',
  index: false,
  dotfiles: 'deny',
  fallthrough: false,
}));

// Browser-based WhatsApp pairing (/admin/qr, /admin/qr.json)
app.use('/admin', adminQr);

// ─── Health / status ────────────────────────────────────────────────
const hasClientBuild = fs.existsSync(path.join(config.clientDist, 'index.html'));

function statusPayload() {
  return {
    name: 'Wingman',
    status: 'running',
    whatsappReady: wa.ready(),
    messagesLogged: conversations.countAll(),
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, whatsappReady: wa.ready() });
});

// ─── TEMPORARY diagnostic: do the WhatsApp templates actually deliver? ──
//   Sends a REAL template message (notify / briefing / wrap) with the exact
//   parameter counts the code uses, so a mismatch between the approved template
//   and the code shows up as Meta's own error BEFORE we rely on it.
app.get('/_diag/template', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const digits = String(req.query.phone || '').replace(/[^0-9]/g, '');
  if (!digits) return res.status(400).json({ error: 'pass ?phone=<digits>&which=notify|briefing|wrap' });
  const which = String(req.query.which || 'notify');

  const config = require('./config');
  const cloudApi = require('./whatsapp/cloudApi');
  const cfg = config.whatsappCloud;

  const templates = {
    notify: { name: cfg.proactiveTemplate, params: ['✅ Wingman template test — this is the notify template working.'] },
    briefing: {
      name: cfg.briefingTemplate,
      params: ['Good morning, Fayyaz!', 'Karachi: 31°C, Clear', '09:00 — Standup • 14:00 — Client call', '2 urgent, 3 need reply', 'Send invoice • Call Amir', 'Have a productive day!'],
    },
    wrap: {
      name: cfg.wrapTemplate,
      params: ["That's a wrap, Fayyaz!", '3/5 tasks', 'replied to 4, 2 pending', '3', 'Review contract • Send the deck', '1 meeting • 17:00 — Board sync', 'Good night! 💤'],
    },
  };

  const t = templates[which];
  if (!t) return res.status(400).json({ error: 'which must be notify, briefing or wrap' });
  if (!t.name) return res.status(400).json({ error: `No template name configured for ${which} (set the env var).` });

  try {
    const sent = await cloudApi.sendTemplate(digits, t.name, cfg.proactiveTemplateLang, [
      { type: 'body', parameters: t.params.map((p) => ({ type: 'text', text: p })) },
    ]);
    res.json({ ok: true, which, template: t.name, param_count: t.params.length, messageId: sent && sent.messages && sent.messages[0] && sent.messages[0].id });
  } catch (err) {
    res.json({ ok: false, which, template: t.name, param_count: t.params.length, error: err.message });
  }
});

// ─── TEMPORARY diagnostic: the "tap to open" briefing nudge ─────────
//   Sends the wingman_briefing_ready template (with its quick-reply button) on
//   demand, so the whole flow can be tested WITHOUT waiting for a user to be
//   dormant 24h. Tap the button on the phone → the real /webhook fires → it
//   sends the full rich free-form briefing/wrap. Gated by ADMIN_PASSWORD.
app.get('/_diag/ready-nudge', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const digits = String(req.query.phone || '').replace(/[^0-9]/g, '');
  if (!digits) return res.status(400).json({ error: 'pass ?phone=<digits>&which=briefing|wrap' });
  const which = String(req.query.which || 'briefing');

  const config = require('./config');
  const cloudApi = require('./whatsapp/cloudApi');
  const usersRepo = require('./db/users');
  const cfg = config.whatsappCloud;

  const name = cfg.briefingReadyTemplate;
  if (!name) return res.status(400).json({ error: 'set BRIEFING_READY_TEMPLATE_NAME first' });

  const user = usersRepo.getByPhone(digits) || usersRepo.getByPhone(`+${digits}`);
  const who = (user && user.name) || 'there';
  const payload = which === 'wrap' ? 'SHOW_WRAP' : 'SHOW_BRIEFING';
  const label = which === 'wrap' ? "day's wrap" : 'morning briefing';

  try {
    const sent = await cloudApi.sendTemplate(digits, name, cfg.proactiveTemplateLang, [
      { type: 'body', parameters: [{ type: 'text', text: who }, { type: 'text', text: label }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload }] },
    ]);
    res.json({ ok: true, which, template: name, payload, hint: 'Now tap the button on WhatsApp — the full rich briefing should follow.', messageId: sent && sent.messages && sent.messages[0] && sent.messages[0].id });
  } catch (err) {
    res.json({ ok: false, which, template: name, error: err.message });
  }
});

// ─── TEMPORARY diagnostic ───────────────────────────────────────────
//   Reports this server's outbound IP and whether it can actually reach a
//   mail host from Railway — used to prove a datacenter-IP firewall block on
//   shared hosting. Guarded by ADMIN_PASSWORD and refuses private targets so
//   it can't be used as an internal port scanner. Remove once webmail works.
app.get('/_diag/net', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const net = require('net');
  const dns = require('dns').promises;
  const outboundUrl = require('./utils/outboundUrl');
  const out = {};

  try {
    const r = await fetch('https://api.ipify.org');
    out.outboundIp = (await r.text()).trim();
  } catch (err) { out.outboundIp = `error: ${err.message}`; }

  const host = String(req.query.host || 'mail.wehearyou.studio');
  const port = parseInt(req.query.port, 10) || 993;
  try {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    out.resolved = addrs.map((a) => a.address);
    if (addrs.some((a) => outboundUrl.isPrivateAddress(a.address))) {
      out.probe = 'refused: target resolves to a private address';
    } else {
      out.probe = await new Promise((resolve) => {
        const sock = net.connect({ host, port });
        const done = (r) => { try { sock.destroy(); } catch (_) {} resolve(r); };
        sock.setTimeout(6000);
        sock.on('connect', () => done(`${host}:${port} REACHABLE`));
        sock.on('timeout', () => done(`${host}:${port} TIMEOUT (blocked by firewall)`));
        sock.on('error', (e) => done(`${host}:${port} ${e.code || e.message}`));
      });
    }
  } catch (err) { out.probe = `error: ${err.message}`; }

  res.json(out);
});

// ─── TEMPORARY diagnostic: why didn't the briefing arrive? ──────────
//   Shows the user's briefing time, timezone, whether they're inside WhatsApp's
//   24h window, and the ACTUAL result of sending a briefing right now (incl. the
//   real Meta error). Gated by ADMIN_PASSWORD. Remove once briefings are fixed.
app.get('/_diag/briefing', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const phone = String(req.query.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.status(400).json({ error: 'pass ?phone=<number, digits only>' });

  const usersRepo = require('./db/users');
  const user = usersRepo.getByPhone(phone) || usersRepo.getByPhone(`+${phone}`);
  if (!user) return res.status(404).json({ error: `no user with phone ${phone}` });

  const { db } = require('./db');
  const t = require('./utils/time');
  const now = new Date();
  const tz = user.timezone || 'Asia/Karachi';

  // Last inbound (role='user') message — this is what opens the 24h window.
  const lastIn = db.prepare(
    "SELECT created_at FROM conversations WHERE user_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
  ).get(user.id);
  const lastInboundAt = lastIn ? lastIn.created_at : null;
  // SQLite stores UTC as 'YYYY-MM-DD HH:MM:SS'; parse it as UTC.
  const lastInMs = lastInboundAt ? Date.parse(lastInboundAt.replace(' ', 'T') + 'Z') : null;
  const hoursSince = lastInMs ? (now - lastInMs) / 3600000 : null;
  const within24h = hoursSince != null && hoursSince < 24;

  const out = {
    phone: user.phone,
    name: user.name,
    onboarded: usersRepo.isOnboarded(user),
    timezone: tz,
    localTimeNow: t.timeLabel(now.toISOString(), tz),
    briefing_time: user.briefing_time || '(unset → 07:00)',
    proactiveness_level: user.proactiveness_level || 'high',
    lastBriefingDate: (user.preferences || {}).lastBriefingDate || null,
    lastInboundAt,
    hoursSinceLastInbound: hoursSince != null ? Math.round(hoursSince * 10) / 10 : null,
    within24hWindow: within24h,
    windowNote: within24h
      ? 'In window — a free-form briefing WILL deliver.'
      : 'OUTSIDE window — a free-form briefing is DROPPED by WhatsApp. Needs a template.',
  };

  const wa = require('./whatsapp/client');
  out.whatsappReady = wa.ready();

  if (req.query.send === '1') {
    out.sendAttempted = true;
    try {
      const mb = require('./services/morningBriefing');
      const agg = await mb.aggregate(user, now);
      const text = mb.format(user, agg);
      out.briefingPreview = text.slice(0, 160);
      // Send directly (not via sendForUser, which swallows the error) so the
      // REAL Meta response surfaces — that's the whole point of this probe.
      await wa.sendMessage(user.phone, text);
      out.sent = true;
    } catch (err) {
      out.sent = false;
      out.sendError = err.message;  // e.g. Meta 131047 = outside 24h window
    }
  } else {
    out.hint = 'Add &send=1 to actually attempt a send and see the real Meta result.';
  }

  res.json(out);
});

// ─── TEMPORARY diagnostic: is the Google Tasks scope actually granted? ──
//   Add &test=1 to push a REAL task into the user's Google Tasks and report the
//   actual result — the definitive proof that WhatsApp → Google sync works.
app.get('/_diag/tasks', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const usersRepo = require('./db/users');
  const digits = String(req.query.phone || '').replace(/[^0-9]/g, '');
  const user = digits ? usersRepo.getByPhone(digits) : null;
  if (!user) return res.status(404).json({ error: `no user with phone ${digits}` });

  const googleTasks = require('./services/googleTasks');
  const accountsRepo = require('./db/googleAccounts');
  const accounts = accountsRepo.listForUser(user.id);

  // Actually create-and-push a test task, and report exactly what came back.
  let liveTest;
  if (req.query.test === '1') {
    try {
      const tasksRepo = require('./db/tasks');
      const created = tasksRepo.create({
        userId: user.id,
        title: `✅ Wingman sync test — ${new Date().toISOString().slice(11, 16)} (safe to delete)`,
        source: 'diag',
      });
      const sync = await googleTasks.mirrorNewLocalTask(created.id);
      liveTest = {
        pushed_to_google: !!sync.synced,
        google_account: sync.accountEmail || null,
        reason: sync.reason || null,
        note: sync.synced
          ? 'Look in your Google Tasks — this task is there now.'
          : 'Push did NOT complete; see reason.',
      };
    } catch (err) {
      liveTest = { pushed_to_google: false, error: err.message };
    }
  }

  res.json({
    live_push_test: liveTest,
    tasks_connected: googleTasks.isConnected(user),
    needed_scope: googleTasks.TASKS_SCOPE,
    google_accounts: accounts.map((a) => ({
      email: a.email,
      is_primary: !!a.is_primary,
      has_tasks_scope: googleTasks.hasTasksScope(a),
      scopes: (a.scopes || '').split(/\s+/).filter(Boolean),
    })),
    verdict: googleTasks.isConnected(user)
      ? 'Tasks scope IS granted — sync should work. If it still fails, check the API/quota.'
      : 'Tasks scope is NOT on any linked account. Add it to the OAuth consent screen, then reconnect Google and grant it.',
  });
});

// ─── TEMPORARY diagnostic: what does the WhatsApp side actually see? ──
//   Settings says connected while chat says otherwise, so this reports the
//   user row the webhook would resolve and exactly what the health tool sees
//   for them. Remove once this is settled.
app.get('/_diag/health', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const usersRepo = require('./db/users');
  const { db } = require('./db');
  const digits = String(req.query.phone || '').replace(/[^0-9]/g, '');
  if (!digits) return res.status(400).json({ error: 'pass ?phone=<digits>' });

  // Exactly how the Cloud API webhook resolves a sender.
  const asWebhookSees = usersRepo.getByPhone(digits);

  // Every row whose phone looks like this number, to expose duplicates stored
  // in a different format (a '+' prefix, spaces, a country-code variant).
  const similar = db.prepare(
    "SELECT id, phone, name, created_at FROM users WHERE replace(replace(phone,'+',''),' ','') LIKE ?"
  ).all(`%${digits.slice(-9)}%`);

  const out = {
    looked_up: digits,
    webhook_finds_user: !!asWebhookSees,
    matching_rows: similar.map((u) => ({ id: u.id, phone: u.phone, name: u.name, created_at: u.created_at })),
    duplicate_accounts: similar.length > 1,
  };

  if (asWebhookSees) {
    const health = require('./services/health');
    out.health_for_that_user = health.connectionStatus(asWebhookSees);
    out.google_health_token_set = !!asWebhookSees.google_health_token;
    out.wearables = require('./db/wearableAccounts').listForUser(asWebhookSees.id)
      .map((a) => ({ provider: a.provider, last_synced_at: a.last_synced_at, last_error: a.last_error }));
    out.reading_count = db.prepare('SELECT count(*) c FROM health_data WHERE user_id = ?')
      .get(asWebhookSees.id).c;
  }

  res.json(out);
});

// ─── TEMPORARY diagnostic: is the Maps key actually working? ─────────
app.get('/_diag/maps', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });

  const config = require('./config');
  const out = {
    key_configured: !!config.maps.apiKey,
    key_tail: config.maps.apiKey ? `…${config.maps.apiKey.slice(-6)}` : null,
  };

  const address = String(req.query.address || 'Clifton, Karachi');
  try {
    const geo = await require('./services/maps').geocode(address);
    out.geocode = geo ? { ok: true, resolved: geo.address, lat: geo.lat, lng: geo.lng }
      : { ok: false, reason: 'ZERO_RESULTS — Google found no match for that text' };
  } catch (err) {
    out.geocode = { ok: false, error: err.message };
    if (err.message === 'MAPS_REQUEST_DENIED') {
      out.likely_cause = 'Key is wrong/restricted, or the Geocoding API is not enabled on the project that owns this key.';
    } else if (err.message === 'MAPS_NOT_CONFIGURED') {
      out.likely_cause = 'MAPS_API_KEY is not set on this deployment.';
    }
  }
  res.json(out);
});

// ─── Health ingest ──────────────────────────────────────────────────
//   Public by design: an iPhone Shortcut (or any automation / wearable cloud)
//   POSTs here. Authenticated by the user's private token in the URL, since
//   Shortcuts cannot hold a session. Apple Health and Health Connect are
//   on-device only, so this is how their data reaches us at all.
app.post('/health/ingest/:token', (req, res) => {
  const health = require('./services/health');
  const user = health.userForToken(req.params.token);
  if (!user) return res.status(401).json({ error: 'Invalid link.' });

  try {
    const result = health.ingest(user.id, req.body, { source: 'shortcut' });
    if (!result.saved && !result.skipped) {
      return res.status(400).json({ error: 'No readings found in that request.' });
    }
    console.log(`[health] ${user.phone}: saved ${result.saved}, skipped ${result.skipped}`);
    res.json({ ok: true, saved: result.saved, skipped: result.skipped });
  } catch (err) {
    console.error('[health] ingest failed:', err.message);
    res.status(500).json({ error: 'Could not store those readings.' });
  }
});

// ─── Work clock webhook ─────────────────────────────────────────────
//   The user's HRMS (or any attendance system) POSTs clock-in / clock-out
//   here. Token in the URL identifies the user, so the sending system needs
//   no account or session of its own — it just fires and forgets.
//     { "event": "clock_in" | "clock_out", "at": "<ISO time, optional>" }
app.post('/work/event/:token', (req, res) => {
  const work = require('./services/work');
  const user = work.userForToken(req.params.token);
  if (!user) return res.status(401).json({ error: 'Invalid link.' });

  try {
    const result = work.handleEvent(user.id, req.body || {}, { source: 'hrms' });
    if (!result.ok) {
      return res.status(400).json({
        error: 'Send "event": "clock_in" or "clock_out".',
        received: (req.body && (req.body.event || req.body.type)) || null,
      });
    }
    console.log(`[work] ${user.phone}: ${result.event}${result.duplicate ? ' (already open)' : ''}`);
    res.json({ ok: true, event: result.event });
  } catch (err) {
    console.error('[work] event failed:', err.message);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

// ─── NOW HRMS company webhook (all employees, one URL) ──────────────
//   The company's HRMS posts EVERY employee's clock event here, identifying the
//   person by their company email in the body. One shared secret (set once for
//   the whole company) authenticates it — so no per-user token/URL. This is the
//   inbound half of the one-tap "Connect NOW HRMS" flow.
//     headers: X-Wingman-Secret: <shared secret>
//     body: { "employee": "<company email>", "event": "clock_in"|"clock_out", "at"?: "<ISO>" }
app.post('/work/company-event', (req, res) => {
  const config = require('./config');
  const crypto = require('crypto');
  const secret = config.nowhrms.sharedSecret;
  if (!secret) return res.status(503).json({ error: 'Integration not configured.' });

  // Constant-time secret check (never leak match/length via timing).
  const sent = String(req.get('X-Wingman-Secret') || '');
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Bad secret.' });
  }

  const body = req.body || {};
  const email = body.employee || body.email || body.employee_email;
  const usersRepo = require('./db/users');
  const user = usersRepo.getByWorkEmployeeRef(email);
  // Unknown email = an employee who hasn't linked Wingman yet. Not an error for
  // the HRMS — ack 200 so it doesn't retry forever; we simply have no one to log.
  if (!user) return res.json({ ok: true, linked: false });

  try {
    const work = require('./services/work');
    const result = work.handleEvent(user.id, body, { source: 'hrms' });
    if (!result.ok) {
      return res.status(400).json({ error: 'Send "event": "clock_in" or "clock_out".' });
    }
    console.log(`[work] company-event ${user.phone} (${email}): ${result.event}${result.duplicate ? ' (already open)' : ''}`);
    res.json({ ok: true, linked: true, event: result.event });
  } catch (err) {
    console.error('[work] company-event failed:', err.message);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

// ─── NOW HRMS event alerts (Phase 1) ───────────────────────────────
//   NOW HRMS forwards an employee event (new project/task assigned, leave
//   decided, payslip) so Wingman can push it to WhatsApp proactively. Same
//   company-level auth as /work/company-event (one shared secret, email routing).
//     headers: X-Wingman-Secret: <shared secret>
//     body: { "employee": "<email>", "type": "project_assigned"|"task_assigned"|...,
//             "title": "...", "message": "...", "due"?, "projectName"?, "taskTitle"? }
app.post('/work/company-notify', (req, res) => {
  const config = require('./config');
  const crypto = require('crypto');
  const secret = config.nowhrms.sharedSecret;
  if (!secret) return res.status(503).json({ error: 'Integration not configured.' });

  const sent = String(req.get('X-Wingman-Secret') || '');
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Bad secret.' });
  }

  const body = req.body || {};
  const email = body.employee || body.email || body.employee_email;
  const usersRepo = require('./db/users');
  const user = usersRepo.getByWorkEmployeeRef(email);
  // Employee hasn't linked Wingman yet — ack so the HRMS doesn't retry; no one to tell.
  if (!user) return res.json({ ok: true, linked: false });

  // Fire-and-forget: the HRMS must never wait on our WhatsApp send.
  const hrmsAlerts = require('./services/hrmsAlerts');
  hrmsAlerts.handleEvent(user, body).catch((e) => console.error('[work] company-notify failed:', e.message));
  res.json({ ok: true, linked: true });
});

// ─── Webhook helpers ────────────────────────────────────────────────
const SIGNIN_REF_RE = /\bWM-([A-HJ-NP-Z2-9]{6})\b/i;

/** Record an inbound WhatsApp message id; false if it was already processed. */
function markInboundSeen(waMessageId) {
  try {
    const { db } = require('./db');
    const r = db.prepare('INSERT OR IGNORE INTO inbound_seen (wa_message_id) VALUES (?)').run(String(waMessageId));
    if (Math.random() < 0.01) db.prepare("DELETE FROM inbound_seen WHERE seen_at < datetime('now', '-3 days')").run();
    return r.changes > 0;
  } catch (_) {
    return true; // never drop a message because the dedupe table misbehaved
  }
}

async function handleSignInReply(m, phoneNumber) {
  const ref = String(m.text).match(SIGNIN_REF_RE)[1].toUpperCase();
  const usersRepo = require('./db/users');
  const existing = usersRepo.getByPhone(phoneNumber);
  // Log it as a real WhatsApp inbound (user_id may still be null for a brand-new
  // number) — it opens the 24h window, so the welcome can go out free-form.
  try {
    conversations.logInbound({ userId: existing ? existing.id : null, content: m.text, phoneNumber, waMessageId: m.id });
  } catch (_) { /* non-fatal */ }
  const r = require('./db/auth').confirmByRef(phoneNumber, ref);
  let reply;
  if (r.ok) {
    reply = `*${r.code}* is your Wingman code.\n\nGo back to the app — you'll be signed in automatically (or type the code there). Don't share it with anyone.`;
  } else if (r.reason === 'other_number') {
    const tail = String(r.phone || '').slice(-4);
    reply = `That sign-in request was for a different number (ending ${tail}). Enter the number you're messaging from, then try again.`;
  } else if (r.reason === 'expired') {
    reply = 'That sign-in request has expired. Tap "Send my code" in the app again and send the new message.';
  } else {
    reply = "I couldn't find that sign-in request. Start again from the app and send the message it opens.";
  }
  console.log(`[webhook] sign-in reply (${phoneNumber}) ref ${ref}: ${r.ok ? 'confirmed' : r.reason}`);
  // The app signs in by polling either way; a failed reply must not stop the batch.
  try { await cloudApi.sendText(phoneNumber, reply); }
  catch (e) { console.warn('[webhook] sign-in reply send failed:', e.message); }
}

// ─── Briefing calls: the ElevenLabs agent asks Wingman mid-call ─────
//   POST /voice/tools/ask  { question, call_token, context? }
//   header X-Wingman-Tool-Secret: briefingCall.toolSecret()
//   The call token is a per-call secret passed to the agent as a dynamic
//   variable, so the answer always comes from THAT caller's own data.
app.post('/voice/tools/ask', async (req, res) => {
  const briefingCall = require('./services/briefingCall');
  const given = String(req.get('x-wingman-tool-secret') || '');
  if (!require('./utils/linkSig').safeEqual(given, briefingCall.toolSecret())) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const body = req.body || {};
  const question = String(body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    const out = await briefingCall.answer(String(body.call_token || ''), question, String(body.context || ''));
    if (out.error) return res.status(404).json(out);
    res.json(out);
  } catch (e) {
    console.warn('[voice/ask] failed:', e.message);
    res.json({ answer: "I couldn't check that right now. I'll message you the answer on WhatsApp." });
  }
});

// ElevenLabs "conversation initiation" webhook — the user called Wingman on
// WhatsApp. Same shared-secret header as the tool above.
app.post('/voice/inbound', async (req, res) => {
  const briefingCall = require('./services/briefingCall');
  // The secret may come as a header or as ?key= on the webhook URL (simpler to
  // configure in ElevenLabs).
  const given = String(req.get('x-wingman-tool-secret') || req.query.key || '');
  if (!require('./utils/linkSig').safeEqual(given, briefingCall.toolSecret())) {
    console.warn(`[voice/inbound] 401 — secret missing/wrong (headers: ${Object.keys(req.headers).join(', ')})`);
    return res.status(401).json({ error: 'unauthorized' });
  }
  console.log(`[voice/inbound] request: ${JSON.stringify(req.body || {}).slice(0, 400)}`);
  try {
    res.json(await briefingCall.inbound(req.body || {}));
  } catch (e) {
    console.warn('[voice/inbound] failed:', e.message);
    res.json({
      type: 'conversation_initiation_client_data',
      dynamic_variables: { user_name: 'there', briefing_kind: 'call', call_purpose: 'They called you. Help as best you can; you could not load their data right now, so say so if they ask about it.', briefing: '', brain: '', local_time: '', call_token: '' },
    });
  }
});

// ─── WhatsApp Cloud API webhook ─────────────────────────────────────
//   GET  → Meta verification handshake (hub.challenge)
//   POST → incoming messages: parse, run the engine, reply via Cloud API.
//   Meta requires a fast 200; we ack immediately and process async.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsappCloud.verifyToken) {
    console.log('[webhook] verified by Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function validWebhookSignature(req) {
  const secret = config.whatsappCloud.appSecret;
  if (!secret) {
    if (!validWebhookSignature.warned) {
      validWebhookSignature.warned = true;
      console.warn('[webhook] WHATSAPP_APP_SECRET is not set — webhook signatures are NOT verified.');
    }
    return true;
  }
  const header = String(req.get('x-hub-signature-256') || '');
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  const expected = 'sha256=' + require('crypto').createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return require('./utils/linkSig').safeEqual(header, expected);
}

app.post('/webhook', (req, res) => {
  if (!validWebhookSignature(req)) {
    console.warn('[webhook] rejected a POST with a bad/missing signature');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack immediately (Meta retries on non-200)
  (async () => {
    try {
      // Log delivery statuses (sent/delivered/read/failed) so we can see WHY a
      // template/OTP message does or doesn't arrive at the recipient.
      const entries = Array.isArray(req.body && req.body.entry) ? req.body.entry : [];
      for (const e of entries) {
        for (const ch of (e.changes || [])) {
          for (const s of ((ch.value && ch.value.statuses) || [])) {
            const err = (s.errors && s.errors[0]) || null;
            const detail = err && err.error_data && err.error_data.details ? ` / ${err.error_data.details}` : '';
            console.log(
              `[webhook:status] ${s.status} -> ${s.recipient_id}` +
              (err ? ` — ERROR ${err.code}: ${err.title || err.message}${detail}` : '')
            );
          }
        }
      }

      const messages = cloudApi.parseIncoming(req.body);
      for (const m of messages) {
        const phoneNumber = String(m.from || '').replace(/[^0-9]/g, '');
        if (!phoneNumber) continue;

        // Meta retries a webhook it thinks failed; never process one message twice.
        if (m.id && !markInboundSeen(m.id)) {
          console.log(`[webhook] duplicate delivery of ${m.id} ignored`);
          continue;
        }

        // Users who signed up in the app may be stored without a country code;
        // the webhook carries the full number, so remember it for sending.
        try {
          const usersRepo = require('./db/users');
          const known = usersRepo.getByPhone(phoneNumber);
          if (known && usersRepo.upgradePhone(known, phoneNumber)) {
            console.log(`[webhook] stored full number for user ${known.id}`);
          }
        } catch (_) { /* never block a message on this */ }

        // Diagnostic: log every inbound message's type up-front, so it's obvious
        // in the logs whether images (and other media) actually reach the webhook.
        console.log(`[webhook] recv type=${m.type} from ${phoneNumber}${m.image ? ` image_id=${m.image.id || 'none'}` : ''}`);

        // Sign-in by reply: the app showed a "WM-XXXXXX" reference and the user
        // sent it from their WhatsApp. That proves they own this number — reply
        // with the code and let the app (polling /api/auth/otp-status) sign in.
        // This is an exact protocol token, not intent matching.
        if (m.type === 'text' && SIGNIN_REF_RE.test(String(m.text || ''))) {
          await handleSignInReply(m, phoneNumber);
          continue;
        }

        // Quick-reply button on a TEMPLATE (e.g. dormant user tapping "Show my
        // briefing"). The tap itself opens the 24h window, so we log it as an
        // inbound message and then send the FULL rich free-form briefing/wrap —
        // which now delivers because the window is open. This is how a dormant
        // user receives the complete version (news + health + formatting) that a
        // template variable could never carry.
        if (m.type === 'button') {
          const payload = (m.button && (m.button.payload || m.button.text)) || '';
          const usersRepo = require('./db/users');
          const u = usersRepo.getByPhone(phoneNumber);
          if (!u || !usersRepo.isOnboarded(u)) {
            console.log(`[webhook] -- (${phoneNumber}) button tap [unregistered, silent]`);
            continue;
          }
          // Record the tap so the customer-service window is open for the send.
          try {
            conversations.logInbound({ userId: u.id, content: payload || '[button tap]', phoneNumber, waMessageId: m.id });
          } catch (_) { /* non-fatal */ }
          try { await wa.deliverHeld(u); } catch (err) { console.warn('[webhook] held delivery failed:', err.message); }
          try {
            const rich = /wrap/i.test(payload)
              ? require('./services/endOfDayWrap')
              : require('./services/morningBriefing');
            // The tap opens the 24h window — deliver the FULL rich version now.
            await rich.sendForUser(u.id, { now: new Date(), full: true });
            try { require('./db/pendingFullSends').clear(u.id, /wrap/i.test(payload) ? 'wrap' : 'briefing'); } catch (_) { /* best-effort */ }
            console.log(`[webhook] ▶ (${phoneNumber}) button "${payload}" → rich send`);
          } catch (err) {
            console.warn('[webhook] button rich send failed:', err.message);
          }
          continue;
        }

        // Voice notes: transcribe first, then treat exactly like a typed
        // message — so every tool works by voice too.
        let wasVoice = false;
        let mediaType = m.type || 'text';
        if (m.type === 'audio' && m.audio && m.audio.id) {
          const voice = require('./services/voice');
          if (!voice.enabled()) {
            await cloudApi.sendText(phoneNumber, "I can't listen to voice notes yet — please send that as text 🙏");
            continue;
          }
          try {
            const media = await cloudApi.downloadMedia(m.audio.id);
            m.text = await voice.transcribe(media.buffer, { filename: 'voice.ogg' });
            wasVoice = true;
            console.log(`[webhook] 🎤 (${phoneNumber}) transcribed: ${m.text}`);
          } catch (err) {
            console.warn('[webhook] transcription failed:', err.message);
            const note = err.message === 'VOICE_NO_CREDIT'
              ? "I couldn't process that voice note — the speech service is out of credit."
              : "Sorry, I couldn't make out that voice note. Could you try again or send it as text?";
            await cloudApi.sendText(phoneNumber, note);
            continue;
          }
          if (!m.text) {
            await cloudApi.sendText(phoneNumber, "That voice note sounded empty — could you try again?");
            continue;
          }
        }

        if (m.type === 'document' && m.document && m.document.id) {
          try {
            const media = await cloudApi.downloadMedia(m.document.id);
            const extracted = await documentReader.extractTextFromBuffer(media.buffer, {
              filename: m.document.filename,
              mimeType: m.document.mimeType || media.mimeType,
            });
            const attachmentText = documentReader.buildAttachmentContext(extracted, {
              intro: m.text ? `User note: ${m.text}` : null,
            });
            if (!attachmentText) {
              await cloudApi.sendText(phoneNumber, "I couldn't read that file yet. Send a PDF, DOCX, XLSX, TXT, CSV, JSON, HTML, or XML file and I'll read it.");
              continue;
            }
            m.text = attachmentText;
          } catch (err) {
            console.warn('[webhook] document read failed:', err.message);
            await cloudApi.sendText(phoneNumber, "Sorry, I couldn't read that attachment. Try sending it again, or send a PDF, DOCX, XLSX, TXT, CSV, JSON, HTML, or XML file.");
            continue;
          }
        }

        // Images / screenshots: read them with vision (OCR + description), then
        // treat the result as the user's message — so Wingman can actually "see"
        // a screenshot, receipt, bill photo, error message, etc.
        if (m.type === 'image' && m.image && m.image.id) {
          try {
            const imageReader = require('./services/imageReader');
            const media = await cloudApi.downloadMedia(m.image.id);
            m.text = await imageReader.readImage(media.buffer, {
              mimeType: m.image.mimeType || media.mimeType,
              caption: m.image.caption || '',
            });
            console.log(`[webhook] 🖼️ (${phoneNumber}) image read (${(media.buffer && media.buffer.length) || 0} bytes)`);
            // Keep the photo so "post this on Facebook/Instagram" works — the
            // engine only ever sees text, so the saved URL rides along with it.
            try {
              const owner = require('./db/users').getByPhone(phoneNumber);
              if (owner) {
                const saved = await require('./services/mediaStore').save(owner.id, media.buffer, {
                  kind: 'uploaded',
                  mimeType: m.image.mimeType || media.mimeType,
                  note: m.image.caption || '',
                });
                m.text = `${m.text}\n\n[The user sent this as a photo. It is saved — image_url: ${saved.url} — use that if they want it posted or shared.]`;
              }
            } catch (err) {
              console.warn('[webhook] image save failed:', err.message);
            }
          } catch (err) {
            console.warn('[webhook] image read failed:', err.message);
            const note = err.message === 'IMAGE_TOO_LARGE'
              ? "That image is a bit too large for me to read — send a smaller version or a screenshot and I'll take a look."
              : "Sorry, I couldn't open that image. Mind sending it again?";
            await cloudApi.sendText(phoneNumber, note);
            continue;
          }
        }

        // Shared location pins carry text too (label + coordinates), so the
        // assistant can route to them. Anything else without text is ignored.
        if (!m.text || (m.type !== 'text' && m.type !== 'interactive' && m.type !== 'location' && m.type !== 'audio' && m.type !== 'document' && m.type !== 'image')) {
          continue;
        }

        console.log(`[webhook] << (${phoneNumber}): ${m.text}`);

        // A briefing/wrap went out earlier as a short template (the user was
        // outside the 24h window) and asked them to reply. This message has
        // re-opened the window, so deliver the full version(s) now — once.
        // A short reply ("ok", "show") is just the trigger; anything longer is
        // also answered normally below.
        try {
          const usersRepo = require('./db/users');
          const pu = usersRepo.getByPhone(phoneNumber);
          if (pu && usersRepo.isOnboarded(pu)) {
            // Messages held while they were outside the 24h window go first.
            let heldCount = 0;
            try { heldCount = await wa.deliverHeld(pu); } catch (err) { console.warn('[webhook] held delivery failed:', err.message); }
            const kinds = require('./db/pendingFullSends').takeAll(pu.id);
            if (heldCount && !kinds.length && String(m.text).trim().length <= 20) {
              // "ok" / "show" was just the reply that let us send it.
              conversations.logInbound({ userId: pu.id, content: m.text, phoneNumber, waMessageId: m.id });
              continue;
            }
            if (kinds.length) {
              const triggerOnly = String(m.text).trim().length <= 20;
              // Longer messages are logged by the engine below — don't double-log.
              if (triggerOnly) conversations.logInbound({ userId: pu.id, content: m.text, phoneNumber, waMessageId: m.id });
              for (const kind of kinds) {
                const svc = kind === 'wrap' ? require('./services/endOfDayWrap') : require('./services/morningBriefing');
                await svc.sendForUser(pu.id, { now: new Date(), full: true });
                console.log(`[webhook] ▶ (${phoneNumber}) reply → full ${kind}`);
              }
              if (triggerOnly) continue;
            }
          }
        } catch (err) {
          console.warn('[webhook] pending full send failed:', err.message);
        }

        const { reply, ignored } = await engine.handleMessage({
          text: m.text,
          phoneNumber,
          meta: { waMessageId: m.id, provider: 'cloud', name: m.name, mediaType },
        });

        // Stay silent to unregistered/unknown senders (no auto-reply spam).
        if (ignored || !reply) {
          console.log(`[webhook] -- (${phoneNumber}) [ignored, silent]`);
          continue;
        }
        await cloudApi.sendText(phoneNumber, reply);
        console.log(`[webhook] >> (${phoneNumber}): ${reply}`);

        // Speak the reply too, when the user's preference calls for it. Text is
        // always sent first so a TTS failure never costs them the answer.
        try {
          const voice = require('./services/voice');
          const usersRepo = require('./db/users');
          const u = usersRepo.getByPhone(phoneNumber);
          if (voice.shouldSpeak(u, wasVoice)) {
            const { buffer, mimeType } = await voice.speak(reply, { user: u });
            await cloudApi.sendAudio(phoneNumber, buffer, { mimeType });
            console.log(`[webhook] 🔊 (${phoneNumber}) voice reply sent`);
          }
        } catch (err) {
          console.warn('[webhook] voice reply failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[webhook] processing error:', err.message);
    }
  })();
});

// JSON status is always available at /api/status; when there is no built
// dashboard, the root URL also returns JSON status (dev/API-only mode).
app.get('/api/status', (req, res) => res.json(statusPayload()));
if (!hasClientBuild) {
  app.get('/', (req, res) => res.json(statusPayload()));
}

// ─── Serve the built dashboard (production) ─────────────────────────
//   In production the Vite build is emitted to client/dist and served by
//   this same Express process, so one URL hosts API + dashboard + /admin/qr.
if (hasClientBuild) {
  app.use(express.static(config.clientDist));
  console.log('[server] Serving built dashboard from', config.clientDist);
} else {
  console.log('[server] No client build found (client/dist). Dashboard served by Vite in dev.');
}

// ─── Recent conversation log (debug) ────────────────────────────────
app.get('/conversations', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(conversations.recent(limit));
});

// ─── Send a WhatsApp message via API (utility) ──────────────────────
//   POST /send  { "to": "9715xxxxxxx", "text": "Hello from Wingman" }
app.post('/send', requireAdmin, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) {
    return res.status(400).json({ error: 'Both "to" and "text" are required' });
  }
  try {
    await wa.sendMessage(to, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual proactive triggers (testing) ──────────────────────────
//   POST /trigger/:job/:userId  where job = morning|wrap|bills|deliveries|followups|taskreminder|taskdue|travel|meetingprep
app.post('/trigger/:job/:userId', requireAdmin, async (req, res) => {
  const { job, userId } = req.params;
  try {
    let out;
    switch (job) {
      case 'morning': out = await require('./services/morningBriefing').sendForUser(userId); break;
      case 'wrap': out = await require('./services/endOfDayWrap').sendForUser(userId); break;
      case 'bills': out = await require('./services/billAlerts').alertForUser(userId); break;
      case 'deliveries': out = await require('./services/deliveryAlerts').returnWindowCheck(userId); break;
      case 'followups': out = await require('./services/followupTracker').checkOverdue(userId); break;
      case 'taskreminder': out = await require('./engine/taskIntents').sendDailyReminder(userId); break;
      case 'taskdue': out = await require('./services/taskDueAlerts').alertForUser(userId); break;
      case 'travel': out = await require('./services/travelAssistant').alertForUser(userId); break;
      case 'meetingprep': out = await require('./services/meetingPrep').prepForUser(userId); break;
      default: return res.status(400).json({ error: 'unknown job' });
    }
    res.json({ ok: true, job, out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent briefings for a user (debug)
app.get('/briefings/:userId', requireAdmin, (req, res) => {
  res.json(require('./db/briefings').listForUser(req.params.userId));
});

// ─── Privacy Policy (required by the App Store, Meta and Google OAuth) ──
//   Registered before the SPA fallback.
app.get(['/privacy', '/privacy-policy'], (req, res) => {
  // One policy for everything: the page lives on the website
  // (landing/privacy/index.html) — App Store, Meta and Google all link there.
  res.redirect(301, config.privacyPolicyUrl);
});

// ─── SPA fallback (production) ───────────────────────────────
//   Any GET that is not an API / admin / auth / static-asset route serves
//   the dashboard shell so client-side routing (e.g. /tasks) works on reload.
//   Registered LAST, and written as middleware to stay Express-5 compatible.
if (hasClientBuild) {
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const p = req.path;
    if (
      p.startsWith('/api') ||
      p.startsWith('/admin') ||
      p.startsWith('/auth') ||
      p === '/health' ||
      p.startsWith('/conversations') ||
      p.startsWith('/send') ||
      p.startsWith('/trigger') ||
      p.startsWith('/briefings') ||
      p.startsWith('/webhook') ||
      p.startsWith('/assets') ||
      p.includes('.') // static files (js/css/svg/png/webmanifest…)
    ) {
      return next();
    }
    res.sendFile(path.join(config.clientDist, 'index.html'));
  });
}

// ─── Crash guards ───────────────────────────────────────────────────
//   whatsapp-web.js / LocalAuth can throw async errors on LOGOUT (e.g. an
//   EBUSY file lock while cleaning the session on Windows). Those must not
//   take down the whole server (API + dashboard + schedulers).
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection (ignored):', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (ignored):', err && err.message ? err.message : err);
});

// ─── Bootstrap ──────────────────────────────────────────────────────
function start() {
  // 1) Initialize database schema
  initSchema();

  // 1b) Merge any duplicate accounts that share a phone (created before phones
  // were normalized), so a person gets exactly one of each proactive message.
  try { require('./db/users').mergeDuplicatePhones(); }
  catch (e) { console.warn('[server] duplicate-account merge skipped:', e.message); }

  // 2) Initialize WhatsApp client (prints QR to terminal + serves it at /admin/qr)
  if (config.disableWhatsapp) {
    console.log('[server] DISABLE_WHATSAPP=1 — skipping WhatsApp init (API/dashboard only).');
  } else {
    wa.initWhatsApp();
  }

  // 2b) Start the email scanner cron (every 15 minutes)
  try {
    require('./services/emailScanner').startCron();
  } catch (e) {
    console.warn('[server] could not start email scanner cron:', e.message);
  }

  // 2c) Start the central proactive scheduler (briefings, wraps, alerts)
  try {
    require('./services/scheduler').init();
  } catch (e) {
    console.warn('[server] could not start scheduler:', e.message);
  }

  // Search index: catch up on everything already in the database (first run
  // after deploy indexes the backlog), off the boot path.
  setTimeout(() => {
    require('./services/userIndex').backfill()
      .then(() => console.log('[index] search index up to date'))
      .catch((e) => console.warn('[index] backfill failed:', e.message));
  }, 20 * 1000).unref();

  // Image store: make sure the folder exists, and clear out old images daily.
  try {
    const mediaStore = require('./services/mediaStore');
    mediaStore.dir();
    mediaStore.cleanup();
    setInterval(() => mediaStore.cleanup(), 24 * 60 * 60 * 1000).unref();
  } catch (e) {
    console.warn('[server] media store init failed:', e.message);
  }

  // 3) Start HTTP server
  app.listen(config.port, () => {
    console.log(`[server] Wingman HTTP API listening on port ${config.port}`);
  });
}

start();

module.exports = app;
