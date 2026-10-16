'use strict';

const { google } = require('googleapis');
const googleAuth = require('../auth/googleAuth');
const documentReader = require('./documentReader');

/** Gmail client for a user, optionally for one specific linked account. */
function gmailFor(user, account = null) {
  const auth = googleAuth.getAuthorizedClient(user, 'gmail', account);
  return google.gmail({ version: 'v1', auth });
}

/**
 * ALL linked Google accounts, so reads (inbox scan, search, reply/forward
 * lookup) cover every connected mailbox — personal + work merge into one view.
 * Sends/creates deliberately use getPrimary elsewhere. Falls back to [null]
 * (the legacy single-token path) for users with no google_accounts rows.
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
 * List recent message ids for a user.
 *
 * @param {Object} user
 * @param {Object} [opts]
 * @param {number} [opts.maxResults=50]
 * @param {string} [opts.query] Gmail search query (e.g. 'is:unread', 'newer_than:1d')
 * @returns {Promise<string[]>} message ids
 */
async function listMessageIds(user, { maxResults = 50, query, account = null } = {}) {
  const gmail = gmailFor(user, account);
  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: query || undefined,
  });
  return (res.data.messages || []).map((m) => m.id);
}

/** Decode a base64url payload part to a UTF-8 string. */
function decodePart(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64').toString('utf8');
}

function decodePartBuffer(data) {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data, 'base64');
}

/** Recursively extract the best-effort plain text body from a payload. */
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data && (!payload.mimeType || payload.mimeType.startsWith('text/'))) {
    return decodePart(payload.body.data);
  }
  if (payload.parts && payload.parts.length) {
    // Prefer text/plain, then text/html, then anything
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    const pick = plain || html || payload.parts[0];
    if (pick.parts) return extractBody(pick);
    let text = decodePart(pick.body && pick.body.data);
    if (pick.mimeType === 'text/html') {
      text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return text;
  }
  return '';
}

function collectAttachments(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body && (payload.body.attachmentId || payload.body.data)) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      attachmentId: payload.body.attachmentId || null,
      data: payload.body.data || null,
      size: payload.body.size || null,
    });
  }
  for (const part of (payload.parts || [])) collectAttachments(part, out);
  return out;
}

async function extractAttachment(gmail, messageId, part) {
  let buffer = part.data ? decodePartBuffer(part.data) : null;
  if ((!buffer || !buffer.length) && part.attachmentId) {
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.attachmentId,
    });
    buffer = decodePartBuffer(res && res.data && res.data.data);
  }

  const extracted = await documentReader.extractTextFromBuffer(buffer, {
    filename: part.filename,
    mimeType: part.mimeType,
  });
  return {
    filename: part.filename,
    mimeType: part.mimeType,
    supported: !!extracted.supported,
    note: extracted.note || null,
    text: extracted.text || '',
    truncated: !!extracted.truncated,
  };
}

/**
 * Fetch one message and normalize to
 * {gmailId, subject, sender, snippet, body, attachments}.
 */
async function getMessage(user, messageId, account = null) {
  const gmail = gmailFor(user, account);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  const msg = res.data;
  const headers = (msg.payload && msg.payload.headers) || [];
  const h = (name) => {
    const found = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return found ? found.value : '';
  };
  const body = extractBody(msg.payload) || msg.snippet || '';
  const attachmentParts = collectAttachments(msg.payload).slice(0, 3);
  const attachments = [];
  for (const part of attachmentParts) {
    try {
      attachments.push(await extractAttachment(gmail, msg.id, part));
    } catch (err) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        supported: false,
        note: `Could not read attachment (${err.message}).`,
        text: '',
        truncated: false,
      });
    }
  }
  const attachmentContext = attachments
    .map((a) => documentReader.buildAttachmentContext({
      filename: a.filename,
      mimeType: a.mimeType,
      supported: a.supported,
      text: a.text,
      truncated: a.truncated,
      note: a.note,
    }))
    .filter(Boolean)
    .join('\n\n');
  const combinedBody = attachmentContext
    ? `${body}\n\n[Email attachments]\n${attachmentContext}`
    : body;
  return {
    gmailId: msg.id,
    threadId: msg.threadId,
    subject: h('Subject'),
    sender: h('From'),
    snippet: msg.snippet || '',
    body: combinedBody.slice(0, 6000), // cap for LLM, incl. attachments
    labelIds: msg.labelIds || [],
    receivedAt: Number(msg.internalDate) ? new Date(Number(msg.internalDate)).toISOString() : null,
    attachments,
  };
}

/**
 * Send a reply email (used for draft_reply send-through, optional).
 */
// RFC 2047: a Subject with non-ASCII (emoji, Urdu, "—") must be encoded or
// some clients show mojibake.
function encodeHeader(v) {
  const str = String(v == null ? '' : v);
  return /^[\x00-\x7F]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

/**
 * Send an email from the user's Gmail. `body` is the plain-text version; pass
 * `html` too and it goes out as multipart/alternative (HTML shown, text as the
 * fallback for clients that don't render HTML).
 */
async function sendMessage(user, { to, subject, body, html = null, threadId, account = null } = {}) {
  const gmail = gmailFor(user, account);
  let mime;
  if (html) {
    const boundary = `wm_alt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    mime = [
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(html), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    mime = `To: ${to}\r\nSubject: ${encodeHeader(subject)}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
  }
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });
  return res.data;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Build a raw RFC-2822 message. multipart/mixed when there are attachments,
 * plain text otherwise. `attachments` = [{ filename, mimeType, dataBase64 }].
 */
function buildRawMime({ to, subject, textBody, attachments = [] }) {
  const headerLines = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0'];

  if (!attachments.length) {
    const raw = `${headerLines.join('\r\n')}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${textBody || ''}`;
    return b64url(raw);
  }

  const boundary = `wingman_${Date.now().toString(36)}`;
  const parts = [];
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset=UTF-8', '', textBody || '', '');
  for (const a of attachments) {
    // Gmail returns base64url; standard MIME wants base64, wrapped at 76 chars.
    const std = String(a.dataBase64 || '').replace(/-/g, '+').replace(/_/g, '/');
    const wrapped = std.replace(/(.{76})/g, '$1\r\n');
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${a.filename || 'file'}"`);
    parts.push(`Content-Disposition: attachment; filename="${a.filename || 'file'}"`);
    parts.push('Content-Transfer-Encoding: base64', '', wrapped, '');
  }
  parts.push(`--${boundary}--`);

  const raw = `${headerLines.join('\r\n')}\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.join('\r\n');
  return b64url(raw);
}

/**
 * Forward an existing email to new recipients, carrying its attachments.
 * Fetches the raw attachment bytes (not the text extraction) so the files
 * arrive intact.
 */
async function forwardMessage(user, { messageId, to, note = '', account = null } = {}) {
  const gmail = gmailFor(user, account);
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const msg = res.data;
  const headers = (msg.payload && msg.payload.headers) || [];
  const h = (name) => {
    const f = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? f.value : '';
  };

  const origBody = extractBody(msg.payload) || msg.snippet || '';
  const forwardedHeader =
    `\r\n\r\n---------- Forwarded message ----------\r\n` +
    `From: ${h('From')}\r\nDate: ${h('Date')}\r\nSubject: ${h('Subject')}\r\nTo: ${h('To')}\r\n\r\n`;
  const textBody = `${note || ''}${forwardedHeader}${origBody}`;

  // Pull the raw bytes of each attachment.
  const attachments = [];
  for (const part of collectAttachments(msg.payload).slice(0, 5)) {
    if (!part.attachmentId) continue;
    try {
      const a = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.attachmentId });
      attachments.push({ filename: part.filename, mimeType: part.mimeType, dataBase64: a.data.data });
    } catch (_) { /* skip an attachment we can't fetch rather than fail the forward */ }
  }

  const subject = /^fwd:/i.test(h('Subject')) ? h('Subject') : `Fwd: ${h('Subject')}`;
  const raw = buildRawMime({ to, subject, textBody, attachments });
  const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { messageId: sent.data.id, to, subject, attachmentsForwarded: attachments.length };
}

/** Get the authenticated user's email address (for sender-self detection). */
async function getProfile(user, account = null) {
  const gmail = gmailFor(user, account);
  const res = await gmail.users.getProfile({ userId: 'me' });
  return { emailAddress: res.data.emailAddress };
}

/**
 * The user's Google identity — email, display name and profile PHOTO — via the
 * OpenID userinfo endpoint (covered by the profile/email scopes we request).
 * Used to show their real Gmail avatar + email in the app.
 */
async function getIdentity(user, account = null) {
  const auth = googleAuth.getAuthorizedClient(user, 'gmail', account);
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const res = await oauth2.userinfo.get();
  return {
    email: res.data.email || null,
    name: res.data.name || null,
    picture: res.data.picture || null,
  };
}

/**
 * Light version of getMessage for LISTING: headers + snippet + labels + the
 * real received time, no body or attachments (much faster, and the time is
 * what "latest" and "when did it come" depend on).
 */
async function getMessageMeta(user, messageId, account = null) {
  const gmail = gmailFor(user, account);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject', 'Date', 'To'],
  });
  const msg = res.data;
  const headers = (msg.payload && msg.payload.headers) || [];
  const h = (name) => {
    const found = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return found ? found.value : '';
  };
  const internal = Number(msg.internalDate);
  const receivedAt = internal ? new Date(internal).toISOString() : (Date.parse(h('Date')) ? new Date(h('Date')).toISOString() : null);
  return {
    gmailId: msg.id,
    threadId: msg.threadId,
    subject: h('Subject'),
    sender: h('From'),
    to: h('To'),
    snippet: msg.snippet || '',
    labelIds: msg.labelIds || [],
    receivedAt,
  };
}

module.exports = { listMessageIds, getMessage, getMessageMeta, sendMessage, forwardMessage, buildRawMime, extractBody, getProfile, getIdentity, accountsFor };
