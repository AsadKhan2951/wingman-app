'use strict';

const { google } = require('googleapis');
const config = require('../config');
const usersRepo = require('../db/users');

// Calendar scopes (read + write events)
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

// Gmail scopes (read, send, modify)
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

// Drive scope (full: browse/read files AND create docs & folders).
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
];

// Google Tasks (read + write).
const TASKS_SCOPES = [
  'https://www.googleapis.com/auth/tasks',
];

// Contacts (read-only): the user's saved address book, used to suggest meeting
// attendees (with their email) — their real saved contacts, not email history.
const CONTACTS_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
];

// Identity — lets us label each linked account with its Google address so a
// user can tell their personal and work accounts apart (and disconnect one).
const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  // profile is REQUIRED for userinfo to return the account's name + PICTURE — without
  // it Google never sends `picture`, so no user ever gets a real avatar. (Existing
  // users must reconnect once to grant it; new users get it on first connect.)
  'https://www.googleapis.com/auth/userinfo.profile',
];

// We request all scopes together so a single consent connects Calendar, Gmail,
// Drive and Google Tasks. Tokens live in google_accounts (one row per linked account); the
// PRIMARY account is mirrored into users.calendar_token / users.gmail_token so
// every pre-existing code path keeps working unchanged.
const SCOPES = [...CALENDAR_SCOPES, ...GMAIL_SCOPES, ...DRIVE_SCOPES, ...TASKS_SCOPES, ...CONTACTS_SCOPES, ...IDENTITY_SCOPES];

// Google Health API (read-only) — sleep, heart rate, steps and body metrics
// from Android, Pixel Watch, Fitbit and anything else that syncs to Google.
//
// Kept deliberately OUT of SCOPES: health data is far more sensitive than a
// calendar, so connecting Gmail must never drag a health consent along, and
// existing users must not be forced to re-consent. Health is opt-in, on its own.
const HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
];

/**
 * Create a fresh OAuth2 client (not yet authorized).
 */
function createOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

/**
 * Build the Google consent URL. We encode the user's phone number in `state`
 * so the callback can map the returned tokens back to the right user.
 *
 * @param {string} phone  digits-only WhatsApp number
 * @param {string[]} [scopes]  scopes to request (defaults to all)
 * @returns {string} consent URL
 */
function getAuthUrl(phone, scopes = SCOPES) {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',              // request a refresh token
    // 'select_account' forces Google's account chooser so a user can add a
    // DIFFERENT second account; 'consent' still forces refresh_token issuance.
    prompt: 'select_account consent',
    scope: scopes,
    state: require('../utils/linkSig').signState(phone || ''),
    include_granted_scopes: true,
  });
}

/**
 * Merge new tokens with an existing stored token JSON string, preserving the
 * refresh_token if Google omits it on re-consent.
 */
function mergeTokens(existingJson, tokens) {
  let existing = {};
  try { existing = JSON.parse(existingJson || '{}'); } catch (_) {}
  const merged = { ...existing, ...tokens };
  if (!merged.refresh_token && existing.refresh_token) {
    merged.refresh_token = existing.refresh_token;
  }
  return merged;
}

/**
 * Exchange an auth code for tokens and persist them on the user
 * (creating the user if needed). Since we request combined scopes, the same
 * token is stored in BOTH calendar_token and gmail_token.
 *
 * @param {string} code   OAuth authorization code
 * @param {string} phone  digits-only WhatsApp number (from state)
 * @returns {Promise<Object>} the updated user row
 */
/**
 * Resolve which Google account a token belongs to. Prefers the userinfo
 * endpoint; falls back to the Gmail profile so accounts linked before the
 * identity scope existed can still be labelled without re-consenting.
 */
async function fetchAccountEmail(oauth2Client) {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const res = await oauth2.userinfo.get();
    if (res && res.data && res.data.email) return res.data.email;
  } catch (_) { /* fall through */ }
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const res = await gmail.users.getProfile({ userId: 'me' });
    if (res && res.data && res.data.emailAddress) return res.data.emailAddress;
  } catch (_) { /* unknown */ }
  return null;
}

async function handleCallback(code, phone) {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  let user = usersRepo.getByPhone(phone);
  if (!user) {
    user = usersRepo.create({ phone });
  }

  // Link this Google account (keyed by its address, so connecting a second
  // account ADDS one rather than replacing the first).
  let linkedIsPrimary = true; // legacy-only path (no accounts table) mirrors as before
  try {
    oauth2Client.setCredentials(tokens);
    const email = await fetchAccountEmail(oauth2Client);
    const accountsRepo = require('../db/googleAccounts');
    const existing = email ? accountsRepo.findByEmail(user.id, email) : null;
    const merged = existing
      ? mergeTokens(existing.token, tokens)   // keep refresh_token across re-consent
      : tokens;
    const linked = accountsRepo.upsertByEmail(user.id, { email, token: merged, scopes: tokens.scope || null });
    // Only the primary account is mirrored into the legacy columns — otherwise
    // linking a second account would silently hijack every existing feature.
    linkedIsPrimary = !!(linked && linked.is_primary);
    // Fresh consent → the "Google expired" state is over.
    require('../services/googleConnection').markOk(user.id);
  } catch (e) {
    console.warn('[auth] could not record google account:', e.message);
  }

  if (!linkedIsPrimary) return usersRepo.getById(user.id);

  const grantedScope = (tokens.scope || '').split(/\s+/);
  const hasCalendar = grantedScope.some((s) => s.includes('calendar'));
  const hasGmail = grantedScope.some((s) => s.includes('gmail'));

  const updates = {};
  // If we can't tell scopes, store in both (combined consent is the default).
  if (hasCalendar || grantedScope.length === 0) {
    updates.calendar_token = JSON.stringify(mergeTokens(user.calendar_token, tokens));
  }
  if (hasGmail || grantedScope.length === 0) {
    updates.gmail_token = JSON.stringify(mergeTokens(user.gmail_token, tokens));
  }
  // Fallback: if neither matched but we got tokens, store in both.
  if (!updates.calendar_token && !updates.gmail_token) {
    updates.calendar_token = JSON.stringify(mergeTokens(user.calendar_token, tokens));
    updates.gmail_token = JSON.stringify(mergeTokens(user.gmail_token, tokens));
  }

  usersRepo.update(user.id, updates);
  return usersRepo.getById(user.id);
}

/** Mirror refreshed tokens into the legacy user columns. */
function syncLegacyTokens(userId, newTokens) {
  const fresh = usersRepo.getById(userId);
  if (!fresh) return;
  const updates = {};
  if (fresh.calendar_token) {
    updates.calendar_token = JSON.stringify(mergeTokens(fresh.calendar_token, newTokens));
  }
  if (fresh.gmail_token) {
    updates.gmail_token = JSON.stringify(mergeTokens(fresh.gmail_token, newTokens));
  }
  if (Object.keys(updates).length) usersRepo.update(userId, updates);
}

/**
 * Build an authorized OAuth2 client for a user.
 *
 * Token source, in order: an explicitly supplied account row → the user's
 * PRIMARY linked account → the legacy users.calendar_token/gmail_token columns
 * (users who connected before multi-account support). Refreshed tokens are
 * persisted back to whichever source they came from.
 *
 * @param {Object} user
 * @param {'calendar'|'gmail'} [service='calendar']
 * @param {Object} [account]  a google_accounts row, to target a specific account
 * @throws CALENDAR_NOT_CONNECTED / GMAIL_NOT_CONNECTED
 */
function getAuthorizedClient(user, service = 'calendar', account = null) {
  const errCode = service === 'gmail' ? 'GMAIL_NOT_CONNECTED' : 'CALENDAR_NOT_CONNECTED';

  let acct = account;
  if (!acct && user && user.id) {
    try { acct = require('../db/googleAccounts').getPrimary(user.id); } catch (_) { acct = null; }
  }

  let tokens = null;
  if (acct && acct.token) {
    try { tokens = JSON.parse(acct.token); } catch (_) { tokens = null; }
  }
  if (!tokens) {
    acct = null;
    const tokenJson = service === 'gmail'
      ? (user && (user.gmail_token || user.calendar_token))
      : (user && (user.calendar_token || user.gmail_token));
    if (!user || !tokenJson) throw new Error(errCode);
    try { tokens = JSON.parse(tokenJson); }
    catch (_) { throw new Error(errCode); }
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    try {
      if (acct) {
        const accountsRepo = require('../db/googleAccounts');
        const fresh = accountsRepo.getById(acct.id);
        if (fresh) {
          accountsRepo.updateToken(acct.id, mergeTokens(fresh.token, newTokens));
          if (fresh.is_primary) syncLegacyTokens(user.id, newTokens);
        }
      } else {
        syncLegacyTokens(user.id, newTokens);
      }
    } catch (_) { /* non-fatal */ }
  });

  return oauth2Client;
}

// ── Google Health (separate, opt-in consent) ─────────────────────────

/**
 * Consent URL for health only. Reuses the same callback route — the `|health`
 * suffix on `state` is what tells the callback which flow came back, so no
 * second redirect URI has to be registered in Google Cloud.
 */
function getHealthAuthUrl(phone) {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: HEALTH_SCOPES,
    state: require('../utils/linkSig').signState(`${phone || ''}|health`),
    include_granted_scopes: true,
  });
}

/** Exchange the code and store the health token on its own column. */
async function handleHealthCallback(code, phone) {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  let user = usersRepo.getByPhone(phone);
  if (!user) user = usersRepo.create({ phone });

  usersRepo.update(user.id, {
    google_health_token: JSON.stringify(mergeTokens(user.google_health_token, tokens)),
  });
  return usersRepo.getById(user.id);
}

/**
 * Authorized client for the Google Health API, or null when not connected.
 * Refreshed tokens are written back so the connection survives on its own.
 */
function getHealthClient(user) {
  if (!user || !user.google_health_token) return null;
  let tokens;
  try { tokens = JSON.parse(user.google_health_token); }
  catch (_) { return null; }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const fresh = usersRepo.getById(user.id);
      usersRepo.update(user.id, {
        google_health_token: JSON.stringify(mergeTokens(fresh && fresh.google_health_token, newTokens)),
      });
    } catch (_) { /* non-fatal */ }
  });
  return oauth2Client;
}

function isHealthConnected(user) {
  return !!(user && user.google_health_token);
}

function disconnectHealth(userId) {
  usersRepo.update(userId, { google_health_token: null });
}

/** Does the user have at least one linked Google account row? */
function hasLinkedAccount(user) {
  if (!user || !user.id) return false;
  try { return require('../db/googleAccounts').countForUser(user.id) > 0; }
  catch (_) { return false; }
}

function isConnected(user) {
  return !!(user && user.calendar_token) || hasLinkedAccount(user);
}

function isEmailConnected(user) {
  return !!(user && user.gmail_token) || hasLinkedAccount(user);
}

module.exports = {
  SCOPES,
  CALENDAR_SCOPES,
  GMAIL_SCOPES,
  DRIVE_SCOPES,
  TASKS_SCOPES,
  HEALTH_SCOPES,
  getHealthAuthUrl,
  handleHealthCallback,
  getHealthClient,
  isHealthConnected,
  disconnectHealth,
  IDENTITY_SCOPES,
  fetchAccountEmail,
  hasLinkedAccount,
  createOAuthClient,
  getAuthUrl,
  handleCallback,
  getAuthorizedClient,
  isConnected,
  isEmailConnected,
};
