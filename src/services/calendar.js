'use strict';

const { google } = require('googleapis');
const usersRepo = require('../db/users');
const calendarCache = require('../db/calendarEvents');
const googleAuth = require('../auth/googleAuth');

/**
 * Build a Google Calendar API client for a user, optionally for one specific
 * linked account. Without an account it uses the user's primary account.
 */
function calendarFor(user, account = null) {
  const auth = googleAuth.getAuthorizedClient(user, 'calendar', account);
  return google.calendar({ version: 'v3', auth });
}

/**
 * ALL linked Google accounts, so calendar reads merge events from every
 * connected account (events are tagged with their account). Event creation uses
 * getPrimary elsewhere. Falls back to [null] (legacy single-token) when there
 * are no google_accounts rows.
 */
function accountsFor(user) {
  try {
    const accts = require('../db/googleAccounts').listForUser(user.id);
    return accts.length ? accts : [null];
  } catch (_) {
    return [null];
  }
}

/**
 * Which linked account a cached event belongs to, so an edit or cancellation
 * is sent to the calendar it actually lives on (not just the primary one).
 */
function accountForEvent(userId, gcalEventId) {
  try {
    const row = calendarCache.findByGcalId(userId, gcalEventId);
    if (row && row.account_id) return require('../db/googleAccounts').getById(row.account_id) || null;
  } catch (_) { /* fall back to primary */ }
  return null;
}

function loadUser(userId) {
  const user = usersRepo.getById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  return user;
}

/**
 * Resolve a named range ("today" | "tomorrow" | "week") OR an explicit
 * {from, to} object into ISO start/end bounds, in the user's timezone.
 *
 * @param {Object} user
 * @param {string|{from:string,to:string}} range
 * @returns {{timeMin:string, timeMax:string, label:string}}
 */
function resolveRange(user, range) {
  const tz = user.timezone || 'Asia/Dubai';

  if (range && typeof range === 'object' && range.from && range.to) {
    return { timeMin: range.from, timeMax: range.to, label: 'that period' };
  }

  // Compute "now" in the user's timezone, then derive day boundaries.
  const now = new Date();
  // Get the date parts in the user's tz
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const baseDay = `${parts.year}-${parts.month}-${parts.day}`;

  const dayStart = (dateStr) => new Date(`${dateStr}T00:00:00`);
  const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
  const iso = (d) => d.toISOString();

  let start = dayStart(baseDay);
  let end = addDays(start, 1);
  let label = 'today';

  // Explicit {from, to} window (used by the dashboard to sync a broad range).
  if (range && typeof range === 'object' && (range.from || range.to)) {
    const from = range.from ? new Date(range.from) : start;
    const to = range.to ? new Date(range.to) : addDays(from, 7);
    return { timeMin: iso(from), timeMax: iso(to), label: 'range' };
  }

  switch ((range || 'today').toString().toLowerCase()) {
    case 'tomorrow':
      start = addDays(start, 1);
      end = addDays(start, 1);
      label = 'tomorrow';
      break;
    case 'week':
    case 'this week':
      end = addDays(start, 7);
      label = 'this week';
      break;
    case 'today':
    default:
      label = 'today';
  }

  return { timeMin: iso(start), timeMax: iso(end), label };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Map a list of emails (or {email} objects) into Google attendee entries,
 * dropping anything that isn't a valid address.
 */
function toAttendees(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .map((a) => (typeof a === 'string' ? a : (a && a.email)))
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e) && !seen.has(e) && seen.add(e))
    .map((email) => ({ email }));
}

// Recognise a video-call link and tag its provider, so the notetaker bot knows
// where to join. Google Meet lives in hangoutLink / conferenceData; Zoom and
// Teams usually only appear in the location or description text.
const MEETING_PATTERNS = [
  { provider: 'meet', re: /https:\/\/meet\.google\.com\/[a-z0-9-]+/i },
  { provider: 'zoom', re: /https:\/\/[a-z0-9.-]*zoom\.us\/(?:j|w|my)\/[^\s"'<>)]+/i },
  { provider: 'teams', re: /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>)]+/i },
];

/**
 * Pull a join URL + provider out of a Google event. Prefers the structured
 * conferenceData/hangoutLink (most reliable for Meet), then falls back to
 * scanning the location and description text (Zoom/Teams). Returns
 * { meetingUrl, meetingProvider } with nulls when there's no call attached.
 */
function extractMeetingLink(ev) {
  // 1) Structured conference data (video entry point).
  const entries = (ev.conferenceData && ev.conferenceData.entryPoints) || [];
  const video = entries.find((e) => e && e.entryPointType === 'video' && e.uri);
  if (video && video.uri) {
    const m = MEETING_PATTERNS.find((p) => p.re.test(video.uri));
    return { meetingUrl: video.uri, meetingProvider: m ? m.provider : 'meet' };
  }
  if (ev.hangoutLink) return { meetingUrl: ev.hangoutLink, meetingProvider: 'meet' };

  // 2) Scan free text (location first, then description).
  const haystack = `${ev.location || ''}\n${ev.description || ''}`;
  for (const p of MEETING_PATTERNS) {
    const found = haystack.match(p.re);
    if (found) return { meetingUrl: found[0], meetingProvider: p.provider };
  }
  return { meetingUrl: null, meetingProvider: null };
}

/**
 * Map a Google event resource into our normalized shape.
 */
function normalize(ev) {
  const startTime = ev.start && (ev.start.dateTime || ev.start.date);
  const endTime = ev.end && (ev.end.dateTime || ev.end.date);
  const { meetingUrl, meetingProvider } = extractMeetingLink(ev);
  return {
    gcalEventId: ev.id,
    title: ev.summary || '(no title)',
    description: ev.description || '',
    location: ev.location || '',
    startTime,
    endTime,
    allDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
    attendees: (ev.attendees || []).map((a) => a.email),
    status: ev.status,
    meetingUrl,
    meetingProvider,
  };
}

/**
 * Fetch events for a range from Google, cache them locally, and return them.
 *
 * @param {string} userId
 * @param {string|{from,to}} dateRange  'today' | 'tomorrow' | 'week' | {from,to}
 * @returns {Promise<{label:string, events:Array}>}
 */
async function getEvents(userId, dateRange = 'today') {
  const user = loadUser(userId);
  const { timeMin, timeMax, label } = resolveRange(user, dateRange);

  // Pull only from the chosen PRIMARY account so the app never mixes personal
  // and work calendars unexpectedly.
  const accounts = accountsFor(user);
  const events = [];
  for (const account of accounts) {
    try {
      const cal = calendarFor(user, account);
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });
      for (const item of (res.data.items || [])) {
        const ev = normalize(item);
        ev.accountId = account ? account.id : null;
        ev.accountEmail = account ? account.email : null;
        events.push(ev);
      }
    } catch (err) {
      const who = account && account.email ? account.email : 'primary';
      console.warn(`[calendar] events fetch failed for ${who}:`, err.message);
      const gc = require('./googleConnection');
      if (gc.isAuthError(err)) await gc.markBroken(user, { account: account && account.email, reason: err.message });
    }
  }

  events.sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
  calendarCache.cacheEvents(userId, events);
  return { label, events, timeMin, timeMax };
}

/**
 * Create a calendar event.
 *
 * @param {string} userId
 * @param {Object} opts {title, startTime, endTime, description, location, timeZone}
 * @returns {Promise<Object>} normalized created event
 */
// Turn a plain word ("daily", "weekly", "every monday") into an RRULE Google
// accepts. Returns null for anything we don't recognise, so a bad value just
// makes a one-off event rather than failing the whole create.
function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' };
function toRRule(recurrence) {
  const r = String(recurrence || '').trim().toLowerCase();
  if (!r) return null;
  if (/^daily|every day$/.test(r)) return 'RRULE:FREQ=DAILY';
  if (/^weekdays?$/.test(r) || r === 'every weekday') return 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (/^monthly|every month$/.test(r)) return 'RRULE:FREQ=MONTHLY';
  if (/^yearly|annually|every year$/.test(r)) return 'RRULE:FREQ=YEARLY';
  const day = Object.keys(WEEKDAYS).find((d) => r.includes(d));
  if (day) return `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAYS[day]}`;
  if (/^weekly|every week$/.test(r)) return 'RRULE:FREQ=WEEKLY';
  return null;
}

async function createEvent(userId, { title, startTime, endTime, description = '', location = '', attendees = [], timeZone, recurrence = null, allDay = false } = {}) {
  const user = loadUser(userId);
  const cal = calendarFor(user);
  const tz = timeZone || user.timezone || 'Asia/Dubai';

  const guests = toAttendees(attendees);
  const requestBody = {
    summary: title,
    description,
    location,
  };

  // All-day events use a plain date (YYYY-MM-DD) with no time/timezone; the end
  // date is exclusive, so a single day's end is the next day.
  if (allDay) {
    const startDate = String(startTime).slice(0, 10);
    const endDate = endTime ? String(endTime).slice(0, 10) : nextDay(startDate);
    requestBody.start = { date: startDate };
    requestBody.end = { date: endDate };
  } else {
    requestBody.start = { dateTime: startTime, timeZone: tz };
    requestBody.end = { dateTime: endTime, timeZone: tz };
  }

  const rrule = toRRule(recurrence);
  if (rrule) requestBody.recurrence = [rrule];

  if (guests.length) requestBody.attendees = guests;

  const res = await cal.events.insert({
    calendarId: 'primary',
    requestBody,
    // 'all' makes Google email the invitation to every attendee.
    sendUpdates: guests.length ? 'all' : 'none',
  });

  const ev = normalize(res.data);
  calendarCache.upsert(userId, ev);
  return ev;
}

/**
 * Add a single attendee to an event without disturbing the rest. Used to
 * auto-invite the notetaker bot so it joins as a guest — Google blocks uninvited
 * (gate-crashing) bots, but an invited one on the guest list joins directly.
 * Silent by default (no email blast to the other guests).
 *
 * @returns {Promise<boolean>} true if newly added, false if already present
 */
async function addAttendee(userId, eventId, email, { notify = false } = {}) {
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) return false;
  const user = loadUser(userId);
  const cal = calendarFor(user, accountForEvent(userId, eventId));

  const cur = await cal.events.get({ calendarId: 'primary', eventId });
  const attendees = Array.isArray(cur.data.attendees) ? cur.data.attendees.slice() : [];
  if (attendees.some((a) => String(a.email || '').toLowerCase() === lower)) return false;
  attendees.push({ email: lower });

  await cal.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody: { attendees },
    sendUpdates: notify ? 'all' : 'none',
  });
  return true;
}

/**
 * Update / reschedule an event.
 *
 * @param {string} userId
 * @param {string} eventId  Google event id
 * @param {Object} updates  {title, startTime, endTime, description, location}
 */
async function updateEvent(userId, eventId, updates = {}) {
  const user = loadUser(userId);
  const cal = calendarFor(user, accountForEvent(userId, eventId));
  const tz = user.timezone || 'Asia/Dubai';

  const requestBody = {};
  if (updates.title !== undefined) requestBody.summary = updates.title;
  if (updates.description !== undefined) requestBody.description = updates.description;
  if (updates.location !== undefined) requestBody.location = updates.location;
  if (updates.startTime) requestBody.start = { dateTime: updates.startTime, timeZone: tz };
  if (updates.endTime) requestBody.end = { dateTime: updates.endTime, timeZone: tz };
  if (updates.attendees !== undefined) {
    const guests = toAttendees(updates.attendees);
    if (guests.length) requestBody.attendees = guests;
  }

  const res = await cal.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody,
    // Notify guests about the reschedule / change by email.
    sendUpdates: 'all',
  });

  const ev = normalize(res.data);
  calendarCache.upsert(userId, ev);
  return ev;
}

/**
 * Cancel / delete an event.
 */
async function deleteEvent(userId, eventId) {
  const user = loadUser(userId);
  const cal = calendarFor(user, accountForEvent(userId, eventId));
  // Notify guests that the meeting was cancelled.
  await cal.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
  calendarCache.removeByGcalId(userId, eventId);
  return { deleted: true, eventId };
}

/**
 * Check whether a [startTime, endTime] slot conflicts with existing events.
 *
 * @returns {Promise<{free:boolean, conflicts:Array}>}
 */
async function checkConflicts(userId, startTime, endTime) {
  const user = loadUser(userId);
  const cal = calendarFor(user);

  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: startTime,
      timeMax: endTime,
      items: [{ id: 'primary' }],
    },
  });

  const busy = (res.data.calendars &&
    res.data.calendars.primary &&
    res.data.calendars.primary.busy) || [];

  return { free: busy.length === 0, conflicts: busy };
}

/**
 * Find events matching a rough time/title hint within a day (helper for
 * "move my 3pm meeting"). Returns normalized events from Google.
 */
async function findEvents(userId, { dateRange = 'today', query } = {}) {
  const { events } = await getEvents(userId, dateRange);
  if (!query) return events;
  const q = query.toLowerCase();
  return events.filter((e) =>
    (e.title || '').toLowerCase().includes(q) ||
    (e.startTime || '').includes(q)
  );
}

module.exports = {
  getEvents,
  createEvent,
  updateEvent,
  addAttendee,
  deleteEvent,
  checkConflicts,
  findEvents,
  resolveRange,
  normalize,
  extractMeetingLink,
};
