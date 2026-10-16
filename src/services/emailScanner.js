'use strict';

const cron = require('node-cron');
const usersRepo = require('../db/users');
const emailItemsRepo = require('../db/emailItems');
const billsRepo = require('../db/bills');
const deliveriesRepo = require('../db/deliveries');
const travelRepo = require('../db/travel');
const gmail = require('./gmail');
const { analyzeEmail } = require('./emailAnalyzer');
const googleAuth = require('../auth/googleAuth');
const deliveryAlerts = require('./deliveryAlerts');
const followupTracker = require('./followupTracker');
const peopleCRM = require('./peopleCRM');
const travelAssistant = require('./travelAssistant');
const t = require('../utils/time');

// wa is required lazily to avoid a circular dependency at module load
function wa() { return require('../whatsapp/client'); }

const crypto = require('crypto');
const { db } = require('../db');

/**
 * A single real payment often arrives as TWO emails (a bank debit + a merchant
 * receipt), each clearing a similarly-named bill ("Easypaisa/Telenor" vs
 * "Easypaisa/Telenor Bank") — so the user got "marked it paid" twice. Reserve
 * ONE paid-confirmation per user per payment within ~an hour. The bill name is
 * normalised (lower-cased, punctuation + filler words like bank/bill/payment
 * stripped) so those variants collapse to the same key. Race-safe via
 * wa_send_dedup; the row is purged within ~an hour so a later, genuinely
 * different payment is never suppressed.
 */
function reservePaidConfirm(phone, billName) {
  try {
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
    const core = String(billName || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(bank|bill|payment|account|acct|ltd|limited|inc|co|the)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const hash = crypto.createHash('sha1').update(core || String(billName || '')).digest('hex').slice(0, 16);
    const info = db.prepare('INSERT OR IGNORE INTO wa_send_dedup (key) VALUES (?)').run(`paidbill:${last10}:${hash}`);
    return info.changes === 1;
  } catch (_) {
    return true;
  }
}

/**
 * Collapse a sender to a stable "who" key so escalating notices from one source
 * (e.g. Vercel's repeated "payment failed" / "failed for the second time" emails
 * — different emails, same issue) are treated as the SAME sender. Prefers the
 * email domain ("billing@vercel.com" -> "vercel"), else the first word of a
 * display name ("Vercel" and "Vercel Inc." -> "vercel").
 */
function urgentSenderCore(sender) {
  const s = String(sender || '').toLowerCase();
  const at = s.match(/@([a-z0-9.-]+)/);
  if (at) return at[1].replace(/\.(com|net|org|io|co|inc|pk|ai)$/, '').replace(/[^a-z0-9]/g, '');
  return (s.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)[0] || s).slice(0, 24);
}

/**
 * Scan a single user's inbox: fetch recent messages, analyze new ones,
 * persist, fan-out to bills/deliveries/travel, and alert on urgent items.
 *
 * @param {string} userId
 * @param {Object} [opts]
 * @param {number} [opts.maxResults=50]
 * @returns {Promise<{scanned:number, newItems:number, urgent:number}>}
 */
async function scanUser(userId, { maxResults = 50 } = {}) {
  const user = usersRepo.getById(userId);
  if (!user || !googleAuth.isEmailConnected(user)) {
    return { scanned: 0, newItems: 0, urgent: 0, skipped: 'not_connected' };
  }

  // Only scan since the last scan (fallback: recent inbox)
  const lastScan = user.preferences && user.preferences.lastEmailScan;
  const query = lastScan
    ? `newer_than:2d in:inbox`   // Gmail query granularity is coarse; we also de-dupe by id
    : `in:inbox newer_than:7d`;

  // Record the user's own email address once, so we can detect sent mail
  // (promises made) reliably.
  if (!(user.preferences && user.preferences.emailAddress)) {
    try {
      const prof = await gmail.getProfile(user);
      if (prof && prof.emailAddress) {
        usersRepo.updatePreferences(userId, { emailAddress: prof.emailAddress });
        user = usersRepo.getById(userId);
      }
    } catch (_) { /* non-fatal */ }
  }

  // Scan EVERY linked Google account, so a user with personal + work mailboxes
  // gets alerts from both. Each message is paired with the account it came from
  // so it is fetched with the right credentials. A failing account is skipped.
  const items = [];
  const seenIds = new Set();
  for (const account of gmail.accountsFor(user)) {
    try {
      const ids = await gmail.listMessageIds(user, { maxResults, query, account });
      // Also include recent SENT mail so the follow-up tracker can capture
      // commitments the user made ("I'll send…").
      const sentIds = await gmail.listMessageIds(user, { maxResults: 20, query: 'in:sent newer_than:7d', account });
      for (const id of [...ids, ...sentIds]) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        items.push({ id, account });
      }
    } catch (err) {
      console.warn(`[emailScanner] list failed for ${(account && account.email) || user.phone}:`, err.message);
      const gc = require('./googleConnection');
      if (gc.isAuthError(err)) await gc.markBroken(user, { account: account && account.email, reason: err.message });
    }
  }
  if (items.length) require('./googleConnection').markOk(user);

  // The user's own email priorities (set in onboarding) — free-form text telling
  // Wingman which people/topics/situations matter. When set, the AI decides per
  // email whether to proactively ping, and writes that ping itself.
  const emailCtx = (user.preferences && user.preferences.emailContext) || {};
  // Plus the standing "tell me / don't tell me about …" rules they gave in chat.
  let ruleText = '';
  try { ruleText = require('../engine/brainExecutor').notifyRulesText(userId); } catch (_) { /* optional */ }
  const ctxText = [String(emailCtx.instructions || '').trim(), ruleText].filter(Boolean).join('\n');
  const notifyOn = !!ctxText && emailCtx.notify !== false;

  let newItems = 0;
  let urgent = 0;
  // Collect urgent emails and send ONE digest at the end, so a batch of urgent
  // mail is a single message — not one ping per email (the "double double" spam).
  const urgentItems = [];
  // Context-driven personalised pings the AI chose to send (see notifyOn).
  const priorityNotifies = [];

  for (const { id, account } of items) {
    if (emailItemsRepo.existsByGmailId(userId, id)) continue; // de-dupe

    let msg;
    try {
      msg = await gmail.getMessage(user, id, account);
    } catch (err) {
      console.warn(`[emailScanner] fetch ${id} failed:`, err.message);
      continue;
    }

    const analysis = await analyzeEmail({
      subject: msg.subject,
      sender: msg.sender,
      body: msg.body || msg.snippet,
    }, { context: ctxText });

    // Persist the analyzed email
    const emailItemId = emailItemsRepo.upsert(userId, {
      gmailId: msg.gmailId,
      accountId: account && account.id ? account.id : null,
      accountEmail: account && account.email ? account.email : null,
      subject: msg.subject,
      sender: msg.sender,
      category: analysis.category,
      summary: analysis.summary,
      actionNeeded: analysis.actionNeeded,
      draftReply: analysis.draftReply,
      detectedType: analysis.detectedType,
      extractedData: analysis.extractedData,
      receivedAt: msg.receivedAt || null,
    });
    newItems++;

    // Fan-out to typed tables
    try {
      const fan = fanOut(userId, emailItemId, analysis);
      // Delivery status-change alert
      if (fan && fan.delivery && fan.delivery.statusChanged) {
        const d = deliveriesRepo.getById(fan.delivery.id);
        if (d) await deliveryAlerts.sendStatusAlert(user, d);
      }
      // We spotted a payment go through and cleared the bill — tell the user ONCE
      // (this replaces future nags, so it's a net reduction in pings).
      if (fan && fan.paidBill) {
        const amt = `${fan.paidBill.currency || 'PKR'} ${Number(fan.paidBill.amount || 0).toLocaleString('en-US')}`;
        try {
          if (wa().ready() && reservePaidConfirm(user.phone, fan.paidBill.name)) {
            await wa().sendMessage(user.phone, `✅ Saw your *${fan.paidBill.name}* payment (${amt}) go through — marked it paid, so I'll stop reminding you.`);
            try { require('../db/agentActions').log(userId, { kind: 'bill.paid', summary: `Marked "${fan.paidBill.name}" paid from a receipt`, source: 'proactive' }); } catch (_) { /* audit best-effort */ }
          }
        } catch (err) { console.warn('[emailScanner] paid-confirmation failed:', err.message); }
      }
      // Compile flight + hotel into a single trip itinerary
      if (fan && fan.tripId) {
        try { travelAssistant.compileItinerary(userId, fan.tripId); }
        catch (e) { console.warn('[emailScanner] itinerary compile failed:', e.message); }
      }
    } catch (err) {
      console.warn('[emailScanner] fan-out failed:', err.message);
    }

    // People CRM: record the sender as a contact interaction
    try {
      const own = user.preferences && user.preferences.emailAddress;
      peopleCRM.recordFromEmail(userId, {
        sender: msg.sender, created_at: new Date().toISOString(),
      }, own);
    } catch (err) {
      console.warn('[emailScanner] contact update failed:', err.message);
    }

    // Follow-up commitment detection (promises made/received)
    try {
      const tz = user.timezone || 'Asia/Karachi';
      const todayDate = t.startOfDayISO(tz, 0).slice(0, 10);
      const userIsSender = isFromUser(user, msg.sender) ||
        (msg.labelIds && msg.labelIds.includes('SENT'));
      await followupTracker.processEmail(userId, {
        id: emailItemId, subject: msg.subject, sender: msg.sender,
      }, { body: msg.body || msg.snippet, userIsSender, todayDate });
    } catch (err) {
      console.warn('[emailScanner] followup detection failed:', err.message);
    }

    // Collect urgent items for a single digest after the scan.
    if (analysis.category === 'urgent') {
      urgent++;
      urgentItems.push({ sender: msg.sender, summary: analysis.summary });
    }
    // The AI, reading the user's own priorities, chose to ping about this one.
    if (notifyOn && analysis.notify && analysis.notifyMessage) {
      priorityNotifies.push(analysis.notifyMessage.trim());
    }
  }

  if (notifyOn) {
    // Priority mode: send the AI's own per-email notes (it's already selective),
    // capped so a big batch can't flood the chat. Replaces the generic urgent
    // digest so the user isn't told twice.
    for (const message of priorityNotifies.slice(0, 4)) {
      try { if (wa().ready()) await wa().sendMessage(user.phone, message); }
      catch (err) { console.warn('[emailScanner] priority notify failed:', err.message); }
    }
    const extra = priorityNotifies.length - 4;
    if (extra > 0) {
      try { if (wa().ready()) await wa().sendMessage(user.phone, `…and ${extra} more email${extra === 1 ? '' : 's'} worth a look — open the Email tab to see them.`); }
      catch (_) { /* best-effort */ }
    }
  } else if (urgentItems.length) {
    // Don't re-alert about the SAME sender within ~a day. Escalating notices from
    // one source (Vercel's repeated payment-failure emails, an Apps-Script error
    // that keeps re-firing) are different emails but the same issue — one alert is
    // enough, not one per email. Tracked per-user in preferences with a timestamp.
    const prefsNow = (usersRepo.getById(userId) || user).preferences || {};
    const alertedSenders = prefsNow.urgentAlertedSenders || {};
    const cutoff = Date.now() - 20 * 3600000;
    for (const k of Object.keys(alertedSenders)) {
      if (!(Number(alertedSenders[k]) > cutoff)) delete alertedSenders[k];
    }
    const fresh = urgentItems.filter((it) => !alertedSenders[urgentSenderCore(it.sender)]);
    if (fresh.length) {
      // One urgent digest for the whole scan (also deduped by subject+sender inside).
      await sendUrgentDigest(user, fresh);
      for (const it of fresh) alertedSenders[urgentSenderCore(it.sender)] = Date.now();
      usersRepo.updatePreferences(userId, { urgentAlertedSenders: alertedSenders });
    }
  }

  // Record last scan time
  usersRepo.updatePreferences(userId, { lastEmailScan: new Date().toISOString() });

  // Enrich frequent contacts (5+ interactions) via Claude, best-effort.
  try { await peopleCRM.refreshContacts(userId, { enrich: true }); }
  catch (err) { console.warn('[emailScanner] CRM enrichment failed:', err.message); }

  return { scanned: items.length, newItems, urgent };
}

/**
 * Insert/update typed records based on detected_type + extracted_data.
 */
function fanOut(userId, emailItemId, analysis) {
  const d = analysis.extractedData || {};

  if (analysis.detectedType === 'bill') {
    billsRepo.upsert(userId, {
      name: d.company || 'Bill',
      amount: parseAmount(d.amount),
      currency: parseCurrency(d.amount),
      dueDate: d.due_date || null,
      status: 'pending',
      sourceEmailId: emailItemId,
    });
  } else if (analysis.detectedType === 'payment_receipt') {
    // The user paid something — clear the matching pending bill so Wingman
    // stops chasing a bill they already settled.
    if (d.company) {
      const paidBill = billsRepo.markPaidByName(userId, d.company);
      if (paidBill) return { paidBill };
    }
  } else if (analysis.detectedType === 'order') {
    const delivery = deliveriesRepo.upsert(userId, {
      itemName: d.item || 'Order',
      merchant: d.store || null,
      carrier: d.carrier || null,
      trackingNumber: d.tracking_number || null,
      estimatedDelivery: d.eta || null,
      status: 'in_transit',
      sourceEmailId: emailItemId,
    });
    return { delivery };
  } else if (analysis.detectedType === 'flight') {
    const departTime = joinDateTime(d.flight_date, d.flight_time);
    const tripId = travelRepo.upsert(userId, {
      tripName: [d.departure, d.arrival].filter(Boolean).join(' → ') || 'Flight',
      type: 'flight',
      provider: d.airline || null,
      confirmationCode: d.flight_number || null,
      origin: d.departure || null,
      destination: d.arrival || null,
      departTime,
      status: 'scheduled',
      sourceEmailId: emailItemId,
    });
    return { tripId };
  }
}

async function sendUrgentDigest(user, items) {
  // Collapse exact repeats (same sender + same summary) so a mailbox that got two
  // near-identical notices doesn't produce two lines.
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const key = `${cleanSender(it.sender)}|${String(it.summary || '').trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }

  let text;
  if (uniq.length === 1) {
    text = `🚨 Urgent email from ${cleanSender(uniq[0].sender)}: ${uniq[0].summary}`;
  } else {
    const lines = [`🚨 *${uniq.length} urgent emails:*`];
    for (const it of uniq.slice(0, 5)) lines.push(`• ${cleanSender(it.sender)}: ${it.summary}`);
    if (uniq.length > 5) lines.push(`…and ${uniq.length - 5} more.`);
    text = lines.join('\n');
  }

  try {
    if (wa().ready()) {
      await wa().sendMessage(user.phone, text);
    } else {
      console.log('[emailScanner] (WA not ready) would alert:', text);
    }
  } catch (err) {
    console.warn('[emailScanner] urgent digest failed:', err.message);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function parseAmount(amountStr) {
  if (amountStr == null) return null;
  const m = String(amountStr).replace(/,/g, '').match(/[\d.]+/);
  return m ? Number(m[0]) : null;
}

function parseCurrency(amountStr) {
  if (!amountStr) return 'PKR';
  const s = String(amountStr).toUpperCase();
  if (s.includes('AED') || s.includes('DHS') || s.includes('DIRHAM')) return 'AED';
  if (s.includes('USD') || s.includes('$')) return 'USD';
  if (s.includes('PKR') || s.includes('RS')) return 'PKR';
  if (s.includes('EUR') || s.includes('€')) return 'EUR';
  if (s.includes('GBP') || s.includes('£')) return 'GBP';
  return 'PKR';
}

function joinDateTime(date, time) {
  if (!date) return null;
  return time ? `${date}T${time}:00` : `${date}T00:00:00`;
}

function cleanSender(sender) {
  if (!sender) return 'someone';
  const m = sender.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : sender).trim();
}

/** Heuristic: was this email sent by the user themselves? */
function isFromUser(user, sender) {
  if (!sender) return false;
  const emailPref = user.preferences && user.preferences.emailAddress;
  if (emailPref && sender.toLowerCase().includes(String(emailPref).toLowerCase())) return true;
  return false;
}

/**
 * Scan all Gmail-connected users (used by cron).
 */
async function scanAllUsers() {
  const users = usersRepo.listConnectedEmailUsers();
  const results = [];
  for (const u of users) {
    try {
      results.push({ phone: u.phone, ...(await scanUser(u.id)) });
    } catch (err) {
      results.push({ phone: u.phone, error: err.message });
    }
  }
  if (results.length) console.log('[emailScanner] cron scan:', JSON.stringify(results));
  return results;
}

let cronTask = null;

/**
 * Start the every-15-minutes cron job. Idempotent.
 */
function startCron() {
  if (cronTask) return cronTask;
  cronTask = cron.schedule('*/15 * * * *', () => {
    scanAllUsers().catch((e) => console.warn('[emailScanner] cron error:', e.message));
  });
  console.log('[emailScanner] cron scheduled: every 15 minutes');
  return cronTask;
}

module.exports = { scanUser, scanAllUsers, startCron, fanOut };
