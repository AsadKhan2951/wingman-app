'use strict';

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const secrets = require('../utils/secrets');
const usersRepo = require('../db/users');
const config = require('../config');

/**
 * Business email over IMAP/SMTP — for mailboxes that aren't Gmail
 * (info@yourdomain.com on cPanel, Zoho, Outlook, …).
 *
 * The password is stored encrypted and only ever decrypted in memory for the
 * duration of a connection.
 */

// Known providers, so most people only have to type an address and password.
const PROVIDERS = [
  { match: /@(gmail|googlemail)\.com$/i, imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', note: 'Gmail requires an app password (2FA on).' },
  { match: /@(outlook|hotmail|live|msn)\./i, imap: 'outlook.office365.com', smtp: 'smtp.office365.com' },
  { match: /@yahoo\./i, imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', note: 'Yahoo requires an app password.' },
  { match: /@zoho\./i, imap: 'imap.zoho.com', smtp: 'smtp.zoho.com' },
  { match: /@(icloud|me)\.com$/i, imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', note: 'iCloud requires an app password.' },
];

/**
 * Best-guess IMAP/SMTP settings for an address. Custom domains overwhelmingly
 * follow the mail.<domain> convention used by cPanel and friends.
 */
function detectSettings(address) {
  const email = String(address || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  for (const p of PROVIDERS) {
    if (p.match.test(email)) {
      return { imapHost: p.imap, imapPort: 993, smtpHost: p.smtp, smtpPort: 465, note: p.note || null, guessed: false };
    }
  }
  if (!domain) return null;
  return { imapHost: `mail.${domain}`, imapPort: 993, smtpHost: `mail.${domain}`, smtpPort: 465, note: null, guessed: true };
}

/** Resolve a user's stored settings, decrypting the password. */
function settingsFor(user) {
  if (!user || !user.webmail_address || !user.webmail_password_enc) throw new Error('WEBMAIL_NOT_CONNECTED');
  let password;
  try { password = secrets.decrypt(user.webmail_password_enc); }
  catch (_) { throw new Error('WEBMAIL_CREDENTIALS_UNREADABLE'); }
  return {
    address: user.webmail_address,
    password,
    imapHost: user.webmail_imap_host,
    imapPort: user.webmail_imap_port || 993,
    smtpHost: user.webmail_smtp_host,
    smtpPort: user.webmail_smtp_port || 465,
    fromName: user.webmail_from_name || null,
  };
}

function imapClient(s) {
  return new ImapFlow({
    host: s.imapHost,
    port: s.imapPort,
    secure: s.imapPort === 993,
    auth: { user: s.address, pass: s.password },
    logger: false,
    // Some shared hosts use self-signed certs; still encrypted in transit.
    tls: { rejectUnauthorized: false },
  });
}

function smtpTransport(s) {
  return nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpPort === 465,
    auth: { user: s.address, pass: s.password },
    tls: { rejectUnauthorized: false },
  });
}

/** Map provider errors to something a user can act on. */
function friendlyError(err) {
  const msg = String((err && err.message) || err || '');

  // ImapFlow reports a rejected login as the bare message "Command failed" and
  // puts the real reason on the error object. Matching on text alone missed the
  // single most common failure — a wrong mailbox password — and surfaced it as
  // an unhelpful "Command failed" instead.
  if (err && (err.authenticationFailed === true || err.serverResponseCode === 'AUTHENTICATIONFAILED')) {
    return 'WEBMAIL_AUTH_FAILED';
  }
  const serverSaid = String((err && (err.responseText || err.response)) || '');
  if (/AUTHENTICATIONFAILED|auth.*fail|invalid.*(user|credential|password)|login.*fail/i.test(serverSaid)) {
    return 'WEBMAIL_AUTH_FAILED';
  }
  // A LOGIN that fails with no detail is, in practice, always credentials.
  if (/^command failed$/i.test(msg.trim())) return 'WEBMAIL_AUTH_FAILED';
  // Brevo (HTTP send) errors — the sender/domain must be authenticated in Brevo.
  if (/^BREVO:/i.test(msg)) {
    if (/unauthor|key not found|invalid.*key/i.test(msg)) return 'WEBMAIL_SEND_KEY_INVALID';
    if (/sender|not been validated|not valid|domain/i.test(msg)) return 'WEBMAIL_SENDER_UNVERIFIED';
    if (/timeout|unreachable/i.test(msg)) return 'WEBMAIL_CONNECTION_FAILED';
    return 'WEBMAIL_SEND_FAILED';
  }
  if (/auth|credential|login|password|AUTHENTICATIONFAILED/i.test(msg)) return 'WEBMAIL_AUTH_FAILED';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'WEBMAIL_HOST_NOT_FOUND';
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg)) return 'WEBMAIL_CONNECTION_FAILED';
  return msg || 'WEBMAIL_ERROR';
}

/**
 * Verify credentials against BOTH IMAP and SMTP before we store anything, so a
 * bad password fails at setup rather than silently later.
 */
async function testConnection({ address, password, imapHost, imapPort, smtpHost, smtpPort }) {
  const s = { address, password, imapHost, imapPort: imapPort || 993, smtpHost, smtpPort: smtpPort || 465 };

  const client = imapClient(s);
  try {
    await client.connect();
    await client.logout();
  } catch (err) {
    throw new Error(`IMAP:${friendlyError(err)}`);
  }

  // SMTP (sending) is checked but NOT required. Most cloud hosts block outbound
  // SMTP, and refusing the whole connection over that left users unable even to
  // READ their customer mail — which works perfectly well over IMAP. So we
  // report whether sending is available and let the caller decide what to say.
  // Sending goes through the user's OWN SMTP server via the relay (the droplet
  // itself can't reach SMTP ports). Check that login now, so a wrong SMTP
  // password shows up at setup instead of on the first reply.
  const relay = require('./smtpRelay');
  if (relay.enabled() && s.smtpHost) {
    try {
      await relay.verify(s);
      return { ok: true, canSend: true, via: 'relay' };
    } catch (err) {
      const code = relay.classify(err) || friendlyError(err);
      console.warn('[webmail] relay verify failed:', String(err.message).slice(0, 200));
      if (!config.brevo.enabled) return { ok: true, canSend: false, sendError: code };
    }
  }
  if (config.brevo.enabled) return { ok: true, canSend: true, via: 'brevo' };

  try {
    await smtpTransport(s).verify();
    return { ok: true, canSend: true, via: 'smtp' };
  } catch (err) {
    return { ok: true, canSend: false, sendError: friendlyError(err) };
  }
}

/** Encrypt + persist a verified mailbox on the user. */
function saveForUser(userId, { address, password, imapHost, imapPort, smtpHost, smtpPort, fromName }) {
  if (!secrets.available()) throw new Error('SECRET_KEY_NOT_SET');
  usersRepo.update(userId, {
    webmail_address: address,
    webmail_password_enc: secrets.encrypt(password),
    webmail_imap_host: imapHost,
    webmail_imap_port: imapPort || 993,
    webmail_smtp_host: smtpHost,
    webmail_smtp_port: smtpPort || 465,
    webmail_from_name: fromName || null,
  });
}

function disconnect(userId) {
  usersRepo.update(userId, {
    webmail_address: null, webmail_password_enc: null,
    webmail_imap_host: null, webmail_imap_port: null,
    webmail_smtp_host: null, webmail_smtp_port: null, webmail_from_name: null,
  });
}

function isConnected(user) {
  return !!(user && user.webmail_address && user.webmail_password_enc);
}

/** Recent messages from the mailbox, newest first. */
async function listRecent(user, { limit = 10, mailbox = 'INBOX' } = {}) {
  const s = settingsFor(user);
  const client = imapClient(s);
  const out = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const total = client.mailbox.exists || 0;
      if (total === 0) return [];
      const from = Math.max(1, total - limit + 1);
      for await (const msg of client.fetch(`${from}:${total}`, { envelope: true, uid: true, bodyStructure: false, flags: true, internalDate: true })) {
        const env = msg.envelope || {};
        const sender = (env.from && env.from[0]) || {};
        out.push({
          uid: msg.uid,
          subject: env.subject || '(no subject)',
          from: sender.address ? `${sender.name ? `${sender.name} ` : ''}<${sender.address}>` : (sender.name || 'unknown'),
          fromAddress: sender.address || null,
          messageId: env.messageId || null,
          date: msg.internalDate ? new Date(msg.internalDate).toISOString() : (env.date ? new Date(env.date).toISOString() : null),
          unread: !(msg.flags && msg.flags.has && msg.flags.has('\\Seen')),
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try { await client.logout(); } catch (_) { /* already down */ }
    throw new Error(friendlyError(err));
  }
  // Newest first by the time it arrived (sequence order can be off after moves).
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

const MAX_BODY_CHARS = 6000;

/** Collapse an HTML body to readable plain text (last resort when no text/plain). */
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Turn a parsed (mailparser) message into our flat shape. */
function shapeParsed(uid, parsed) {
  const fromVal = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  let body = (parsed.text || '').trim();
  if (!body && parsed.html) body = htmlToText(parsed.html);
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n…(truncated)`;
  return {
    uid: Number(uid),
    subject: parsed.subject || '(no subject)',
    from: (parsed.from && parsed.from.text) || fromVal.address || 'unknown',
    fromAddress: fromVal.address || null,
    to: (parsed.to && parsed.to.text) || null,
    date: parsed.date ? parsed.date.toISOString() : null,
    messageId: parsed.messageId || null,
    body,
  };
}

/**
 * Read ONE message in full (headers + body text) by UID. Needed to summarise an
 * email and to write an informed reply. Downloads the raw RFC822 and parses it.
 */
async function readMessage(user, uid, { mailbox = 'INBOX' } = {}) {
  const s = settingsFor(user);
  const client = imapClient(s);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    let parsed;
    try {
      const dl = await client.download(String(uid), undefined, { uid: true });
      if (!dl || !dl.content) return null;
      parsed = await simpleParser(dl.content);
    } finally {
      lock.release();
    }
    await client.logout();
    return shapeParsed(uid, parsed);
  } catch (err) {
    try { await client.logout(); } catch (_) { /* already down */ }
    throw new Error(friendlyError(err));
  }
}

/**
 * Read several messages' bodies over a SINGLE connection (used by the proactive
 * alert). Opening one connection for many uids avoids the rapid connect/logout
 * bursts that shared cPanel/Dovecot hosts throttle. Returns a Map(uid → shaped).
 * A message that fails to fetch/parse is simply skipped.
 */
async function readBodies(user, uids, { mailbox = 'INBOX' } = {}) {
  const out = new Map();
  if (!uids || !uids.length) return out;
  const s = settingsFor(user);
  const client = imapClient(s);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      for (const uid of uids) {
        try {
          const dl = await client.download(String(uid), undefined, { uid: true });
          if (dl && dl.content) out.set(Number(uid), shapeParsed(uid, await simpleParser(dl.content)));
        } catch (_) { /* skip this one */ }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    try { await client.logout(); } catch (_) { /* already down */ }
    throw new Error(friendlyError(err));
  }
  return out;
}

/**
 * Reply to an existing message: fetch the original, then send to its sender with
 * a "Re:" subject and proper threading headers (In-Reply-To / References).
 * The caller (the AI) writes the reply body.
 */
async function replyMessage(user, uid, bodyText) {
  const orig = await readMessage(user, uid);
  if (!orig || !orig.fromAddress) throw new Error('WEBMAIL_ORIGINAL_NOT_FOUND');
  const subject = /^\s*re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
  const r = await send(user, { to: orig.fromAddress, subject, body: bodyText, replyTo: orig.messageId });
  return { ...r, to: orig.fromAddress, subject, repliedTo: orig.from };
}

/** Build the finished message (headers + body) exactly as it will be sent. */
async function compose(s, { to, subject, body, replyTo }) {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const domain = String(s.address).split('@')[1] || 'wingman.local';
  const messageId = `<${Date.now().toString(36)}.${require('crypto').randomBytes(6).toString('hex')}@${domain}>`;
  const raw = await new MailComposer({
    from: s.fromName ? { name: s.fromName, address: s.address } : s.address,
    to,
    subject: subject || '(no subject)',
    text: body || '',
    messageId,
    date: new Date(),
    inReplyTo: replyTo || undefined,
    references: replyTo || undefined,
  }).compile().build();
  return { raw: raw.toString('utf8'), messageId };
}

/** Put a copy of a sent message in the mailbox's Sent folder (best effort). */
async function saveToSent(s, raw) {
  const client = imapClient(s);
  try {
    await client.connect();
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent')
      || boxes.find((b) => /^(inbox[./])?sent( items| messages| mail)?$/i.test(b.path));
    await client.append(sent ? sent.path : 'Sent', raw, ['\\Seen']);
    return true;
  } catch (err) {
    console.warn('[webmail] could not save to Sent:', err.message);
    return false;
  } finally {
    try { await client.logout(); } catch (_) { /* closed */ }
  }
}

/** Send a message from the user's business address. */
async function send(user, { to, subject, body, replyTo } = {}) {
  const s = settingsFor(user);

  // 1) Through the user's OWN mail server, via the relay — the mail truly comes
  //    from their mailbox and lands in their Sent folder.
  const relay = require('./smtpRelay');
  if (relay.enabled() && s.smtpHost) {
    const { raw, messageId } = await compose(s, { to, subject, body, replyTo });
    try {
      await relay.deliver(s, { from: s.address, to, raw });
      await saveToSent(s, raw);
      return { messageId, from: s.address, via: 'relay' };
    } catch (err) {
      const code = relay.classify(err) || 'WEBMAIL_SEND_FAILED';
      console.warn('[webmail] relay send failed:', String(err.message).slice(0, 300));
      // Wrong password or a rejected recipient won't be fixed by another route.
      if (code === 'WEBMAIL_AUTH_FAILED' || code === 'WEBMAIL_RECIPIENT_REJECTED' || !config.brevo.enabled) {
        const e = new Error(code);
        e.detail = String(err.message).replace(/^RELAY:/, '').slice(0, 200);
        throw e;
      }
      // else fall through to Brevo (works when this domain is verified there)
    }
  }

  // Prefer Brevo's HTTP API — Railway blocks outbound SMTP, so the mailbox's
  // own SMTP server is unreachable from here. The From stays the business
  // address; Brevo keeps it deliverable via the authenticated domain.
  if (config.brevo.enabled) {
    const brevo = require('./brevo');
    const info = await brevo.sendEmail({
      from: s.address,
      fromName: s.fromName,
      to,
      subject,
      text: body,
      replyTo: s.address,
      inReplyTo: replyTo || undefined,
    }).catch((err) => { throw new Error(friendlyError(err)); });
    return { messageId: info.messageId, from: s.address, via: 'brevo' };
  }

  const info = await smtpTransport(s).sendMail({
    from: s.fromName ? `"${s.fromName}" <${s.address}>` : s.address,
    to,
    subject: subject || '(no subject)',
    text: body || '',
    inReplyTo: replyTo || undefined,
    references: replyTo || undefined,
  }).catch((err) => { throw new Error(friendlyError(err)); });
  return { messageId: info.messageId, from: s.address };
}

module.exports = {
  detectSettings, testConnection, saveForUser, disconnect, isConnected,
  listRecent, readMessage, readBodies, replyMessage, send, settingsFor, compose,
};
