'use strict';

/**
 * Runs the record-lookup tools (see recordsTools.js) on top of the existing
 * services. Never throws — errors come back as { error } for Claude to explain.
 * Each tool returns `text`: a ready, formatted answer the assistant can pass on
 * (translated / trimmed to fit what was asked).
 */

const usersRepo = require('../db/users');
const googleAuth = require('../auth/googleAuth');
const billAlerts = require('../services/billAlerts');
const deliveryAlerts = require('../services/deliveryAlerts');
const travelAssistant = require('../services/travelAssistant');
const peopleCRM = require('../services/peopleCRM');
const emailDigest = require('../services/emailDigest');

// Which per-user skill toggle each tool belongs to (none = always available).
const SKILL = {
  list_bills: 'bill_tracker',
  mark_bill_paid: 'bill_tracker',
  list_deliveries: 'delivery_tracker',
  list_trips: 'travel_assistant',
  trip_itinerary: 'travel_assistant',
  trip_cost: 'travel_assistant',
  contact_info: 'people_crm',
  top_contacts: 'people_crm',
};

const { db } = require('../db');
const t = require('../utils/time');

function whenLabel(iso, tz) {
  return iso ? `${t.dayLabel(iso, tz)} ${t.timeLabel(iso, tz)}` : null;
}

/** Sender's display name from "Name <addr>". */
function senderName(s) {
  const m = String(s || '').match(/^\s*"?([^"<]+?)"?\s*(?:<|$)/);
  return ((m ? m[1] : s) || 'unknown').trim().slice(0, 60);
}

function emailRow(e, tz) {
  const when = e.received_at || e.created_at;
  return {
    id: e.id,
    mailbox: String(e.gmail_id || '').startsWith('webmail:') ? 'business' : 'gmail',
    account: e.account_email || null,
    from: senderName(e.sender),
    from_full: e.sender,
    subject: e.subject,
    received: whenLabel(when && !/[zZ]|[+-]\d\d:?\d\d$/.test(when) ? `${when.replace(' ', 'T')}Z` : when, tz),
    summary: e.summary,
    type: e.detected_type || 'general',
    category: e.category || 'fyi',
    needs_reply: (e.category === 'needs_reply' || e.category === 'urgent') && !e.replied,
    replied: !!e.replied,
    has_draft_reply: !!e.draft_reply,
  };
}

function emailOverview(user, input = {}) {
  const tz = user.timezone || 'Asia/Karachi';
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 15, 1), 40);
  const where = ['user_id = ?'];
  const args = [user.id];
  const view = input.view || 'all';
  if (view === 'needs_reply') where.push("category IN ('needs_reply','urgent') AND COALESCE(replied,0) = 0");
  if (view === 'urgent') where.push("category = 'urgent'");
  if (view === 'handled') where.push("(COALESCE(replied,0) = 1 OR category NOT IN ('needs_reply','urgent'))");
  if (input.mailbox === 'business') where.push("gmail_id LIKE 'webmail:%'");
  if (input.mailbox === 'gmail') where.push("(gmail_id IS NULL OR gmail_id NOT LIKE 'webmail:%')");
  const type = String(input.type || '').toLowerCase().trim();
  if (type === 'cancellation') {
    // Older rows were stored before this type existed — match the words too.
    where.push("(detected_type = 'cancellation' OR LOWER(subject || ' ' || COALESCE(summary,'')) LIKE '%cancel%')");
  } else if (type) {
    where.push('detected_type = ?'); args.push(type);
  }
  if (input.search) {
    where.push("LOWER(COALESCE(sender,'') || ' ' || COALESCE(subject,'') || ' ' || COALESCE(summary,'')) LIKE ?");
    args.push(`%${String(input.search).toLowerCase()}%`);
  }
  if (Number(input.since_days) > 0) {
    where.push("COALESCE(received_at, created_at) >= ?");
    args.push(new Date(Date.now() - Number(input.since_days) * 86400000).toISOString().replace('T', ' ').slice(0, 19));
  }
  const rows = db.prepare(`SELECT * FROM email_items WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(received_at, created_at) DESC LIMIT ?`).all(...args, limit);
  const gmailOn = googleAuth.isEmailConnected(user);
  const businessOn = !!user.webmail_address;
  if (!gmailOn && !businessOn) return { error: 'EMAIL_NOT_CONNECTED' };
  const gc = require('../services/googleConnection');
  return {
    connected: { gmail: gmailOn, business: businessOn ? user.webmail_address : false },
    ...(gc.isBroken(user) ? { warning: 'Google connection expired — Gmail emails here may be old. Send the reconnect link.' } : {}),
    count: rows.length,
    emails: rows.map((e) => emailRow(e, tz)),
    note: 'Newest first. "received" is already in the user\'s timezone. Label each email Gmail or business when both are connected.',
  };
}

function needsAttention(user) {
  const tz = user.timezone || 'Asia/Karachi';
  const now = new Date();
  const overdue = require('../db/tasks').listOverdue(user.id, now.toISOString()).slice(0, 25).map((tk) => ({
    task_id: tk.id, title: tk.title, was_due: whenLabel(tk.due_date, tz), source: tk.source || 'manual',
  }));
  const waiting = db.prepare(`SELECT * FROM email_items WHERE user_id = ? AND category IN ('needs_reply','urgent')
    AND COALESCE(replied,0) = 0 ORDER BY COALESCE(received_at, created_at) DESC LIMIT 25`).all(user.id).map((e) => emailRow(e, tz));
  // Today's clashes: events that overlap another one.
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  const evs = db.prepare(`SELECT * FROM calendar_events WHERE user_id = ? AND start_time < ? AND end_time > ?
    ORDER BY start_time`).all(user.id, end.toISOString(), start.toISOString());
  const clashes = [];
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      if (String(evs[j].start_time) < String(evs[i].end_time) && evs[i].id !== evs[j].id && evs[i].title !== evs[j].title) {
        clashes.push({ a: evs[i].title, a_time: whenLabel(evs[i].start_time, tz), b: evs[j].title, b_time: whenLabel(evs[j].start_time, tz) });
      }
    }
  }
  return {
    total: overdue.length + waiting.length + clashes.length,
    overdue_tasks: overdue,
    emails_waiting_reply: waiting,
    calendar_clashes_today: clashes.slice(0, 10),
    note: 'This is exactly what the app\'s "Needs attention" shows. Summarise: counts first, then the most important few.',
  };
}

async function executeRecordsTool(user, toolUse) {
  const { name, input = {} } = toolUse;
  try {
    if (!user) return { error: 'NO_USER' };
    const skill = SKILL[name];
    if (skill && !usersRepo.hasSkill(user, skill)) {
      return { error: 'FEATURE_OFF', detail: `The user has switched off "${skill.replace(/_/g, ' ')}" in Settings. Tell them they can turn it on there.` };
    }

    switch (name) {
      case 'search_user_data': {
        const idx = require('../services/userIndex');
        // Dates are stored both as 'YYYY-MM-DD HH:MM:SS' and ISO 'YYYY-MM-DDTHH:MM…';
        // '~' sorts after both, so an end bound of 'YYYY-MM-DD~' includes that whole day.
        const day = (d, end) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${String(d).slice(0, 10)}${end ? '~' : ''}` : undefined);
        const results = idx.search(user.id, input.query, {
          sources: input.sources, since: day(input.since), until: day(input.until, true), limit: input.limit,
        });
        if (!results.length) {
          return { results: [], indexed: idx.stats(user.id), note: 'Nothing matched. Try other keywords (names, company, topic in English) or a wider date range; for very recent items use the live tools.' };
        }
        return { results };
      }
      case 'open_user_record': {
        const d = require('../services/userIndex').getDoc(user.id, input.source, input.ref_id);
        return d || { error: 'NOT_FOUND' };
      }
      case 'list_bills':
        return { text: billAlerts.buildBillsReply(user) };
      case 'mark_bill_paid':
        return { text: billAlerts.handleMarkPaid(user, String(input.name || '').trim()) };
      case 'list_deliveries':
        return { text: deliveryAlerts.buildDeliveriesReply(user) };
      case 'list_trips':
        return { text: travelAssistant.buildTripsReply(user) };
      case 'trip_itinerary':
        return { text: await travelAssistant.buildItineraryReply(user, String(input.destination || '').trim()) };
      case 'trip_cost':
        return { text: travelAssistant.buildTripCostReply(user, String(input.destination || '').trim()) };
      case 'city_weather':
        return { text: await travelAssistant.buildWeatherReply(String(input.city || '').trim()) };
      case 'contact_info':
        return { text: peopleCRM.buildContactReply(user, String(input.name || '').trim()) };
      case 'top_contacts':
        return { text: peopleCRM.buildTopContactsReply(user) };
      case 'inbox_digest':
        if (!googleAuth.isEmailConnected(user) && !user.webmail_address) return { error: 'EMAIL_NOT_CONNECTED' };
        return { text: emailDigest.buildDigest(user.id) };
      case 'email_overview':
        return emailOverview(user, input);
      case 'needs_attention':
        return needsAttention(user);
      default:
        return { error: 'UNKNOWN_TOOL' };
    }
  } catch (e) {
    console.warn(`[records] ${name} failed:`, e.message);
    return { error: 'LOOKUP_FAILED', detail: String(e.message || '').slice(0, 200) };
  }
}

module.exports = { executeRecordsTool };
