'use strict';

/**
 * Pre-briefing refresh — every day, ~30 minutes before each user's briefing
 * and wrap time, pull everything fresh (calendar, Gmail, Google Tasks,
 * business mail, search index, profile card) so the briefing — and the call,
 * if they get one — runs on up-to-date data.
 *
 * For users with voice briefings on, the briefing text is also built ahead of
 * time and cached (preferences.prebuilt), so the call starts instantly instead
 * of waiting for the briefing to be assembled.
 *
 * Runs from the 15-minute briefing tick (scheduler). Best-effort throughout:
 * one source failing never stops the rest.
 */

const usersRepo = require('../db/users');
const t = require('../utils/time');

const LEAD_MIN = 30;

const DEFAULT_TIME = { briefing: '07:00', wrap: '20:00' };

function targetFor(user, kind) {
  return (kind === 'wrap' ? user.debrief_time : user.briefing_time) || DEFAULT_TIME[kind];
}

/** "HH:MM" minus `min` minutes, wrapping past midnight. */
function minus(hhmm, min) {
  const m = t.parseHhMm(hhmm);
  if (m == null) return null;
  const v = (((m - min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

async function attempt(label, fn) {
  try { return await fn(); } catch (e) { console.warn(`[preBriefing] ${label}: ${e.message}`); return null; }
}

/** Pull everything fresh for one user (and pre-build the briefing for callers). */
async function refreshUser(userId, kind = 'briefing', { now = new Date() } = {}) {
  const user = usersRepo.getById(userId);
  if (!user) return { ok: false };
  const google = require('../auth/googleAuth');
  const done = [];

  if (google.isConnected(user)) {
    const from = new Date(now.getTime() - 2 * 3600000).toISOString();
    const to = new Date(now.getTime() + 48 * 3600000).toISOString();
    if (await attempt('calendar', () => require('./calendar').getEvents(user.id, { from, to }))) done.push('calendar');
    if (await attempt('gmail', () => require('./emailScanner').scanUser(user.id, { maxResults: 40 }))) done.push('gmail');
    if (await attempt('tasks', () => require('./googleTasks').syncUser(user.id))) done.push('tasks');
  }
  if (user.webmail_address) {
    if (await attempt('business mail', () => require('./webmailInbox').syncUser(user.id))) done.push('business mail');
  }
  await attempt('profile card', () => require('./userProfile').refresh(user.id));

  // Callers: build the briefing now so the call can start the moment it's due.
  const call = require('./briefingCall');
  const fresh = usersRepo.getById(user.id) || user;
  if (call.isOn(fresh)) {
    const svc = kind === 'wrap' ? require('./endOfDayWrap') : require('./morningBriefing');
    const built = await attempt('prebuild', () => svc.sendForUser(user.id, { now, send: false }));
    if (built && built.text) {
      usersRepo.updatePreferences(user.id, { prebuilt: { kind, text: built.text, at: new Date().toISOString() } });
      done.push('prebuilt');
    }
  }
  return { ok: true, done };
}

/** The cached briefing text, if it was built recently for this kind. */
function prebuiltText(user, kind, { maxAgeMin = 90, now = new Date() } = {}) {
  const p = (user && user.preferences && user.preferences.prebuilt) || null;
  if (!p || !p.text || (kind && p.kind !== kind)) return '';
  const age = (now.getTime() - (Date.parse(p.at) || 0)) / 60000;
  return age >= 0 && age <= maxAgeMin ? p.text : '';
}

/** Scheduler (every 15 min): refresh users whose briefing/wrap is ~30 min away. */
async function runDue({ now = new Date(), windowMin = 15 } = {}) {
  const users = usersRepo.listOnboarded();
  const results = [];
  for (const u of users) {
    const tz = u.timezone || 'Asia/Karachi';
    for (const kind of ['briefing', 'wrap']) {
      const at = minus(targetFor(u, kind), LEAD_MIN);
      if (!at || !t.isDueAt(tz, at, now, windowMin)) continue;
      const dayKey = `${kind}:${t.dateKeyInTz(tz, now)}`;
      const prefs = u.preferences || {};
      if (prefs.lastPrefetch === dayKey) continue;
      usersRepo.updatePreferences(u.id, { lastPrefetch: dayKey });
      const r = await attempt(`user ${u.id}`, () => refreshUser(u.id, kind, { now }));
      results.push({ user: u.id, kind, done: (r && r.done) || [] });
    }
  }
  if (results.length) {
    await attempt('search index', () => require('./userIndex').syncAll());
    console.log('[preBriefing]', JSON.stringify(results));
  }
  return results;
}

module.exports = { runDue, refreshUser, prebuiltText, minus, LEAD_MIN };
