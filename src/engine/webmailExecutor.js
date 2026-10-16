'use strict';

const webmail = require('../services/webmail');
const contactsRepo = require('../db/contacts');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Execute a business-mailbox tool. Never throws — errors become {error}. */
async function executeWebmailTool(user, toolUse) {
  if (!webmail.isConnected(user)) {
    return { error: 'WEBMAIL_NOT_CONNECTED' };
  }

  const { name, input } = toolUse;
  try {
    switch (name) {
      case 'list_business_emails': {
        const limit = Math.min(Math.max(parseInt(input.limit, 10) || 10, 1), 25);
        const messages = await webmail.listRecent(user, { limit });
        const tz = user.timezone || 'Asia/Karachi';
        const t = require('../utils/time');
        return {
          mailbox: `business (${user.webmail_address})`,
          count: messages.length,
          emails: messages.map((m) => ({
            ...m,
            mailbox: 'business',
            received: m.date ? `${t.dayLabel(m.date, tz)} ${t.timeLabel(m.date, tz)}` : null,
          })),
          order: 'newest first; "received" is in the user\'s timezone',
        };
      }

      case 'read_business_email': {
        const uid = parseInt(input.uid, 10);
        if (!uid) return { error: 'INVALID_UID', detail: 'Pass the uid from list_business_emails.' };
        const msg = await webmail.readMessage(user, uid);
        if (!msg) return { error: 'EMAIL_NOT_FOUND', detail: `No message with uid ${uid}.` };
        return { mailbox: user.webmail_address, email: msg };
      }

      case 'reply_business_email': {
        const uid = parseInt(input.uid, 10);
        if (!uid) return { error: 'INVALID_UID', detail: 'Pass the uid of the email to reply to.' };
        const r = await webmail.replyMessage(user, uid, input.body || '');
        try { if (r.to) contactsRepo.recordInteraction(user.id, { email: r.to, at: new Date().toISOString() }); } catch (_) {}
        return { sent: true, from: r.from, to: r.to, subject: r.subject };
      }

      case 'send_business_email': {
        const to = String(input.to || '').trim();
        if (!EMAIL_RE.test(to)) {
          return { error: 'INVALID_RECIPIENT', detail: `"${to}" is not a valid email address.` };
        }
        const r = await webmail.send(user, {
          to,
          subject: input.subject || '(no subject)',
          body: input.body || '',
        });
        try { contactsRepo.recordInteraction(user.id, { email: to, at: new Date().toISOString() }); } catch (_) {}
        return { sent: true, from: r.from, to, subject: input.subject || '(no subject)' };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = (err && err.message) || 'webmail_operation_failed';
    if (msg === 'WEBMAIL_AUTH_FAILED') {
      return { error: 'WEBMAIL_AUTH_FAILED', detail: 'The mailbox password was rejected — the user should reconnect it in Settings.' };
    }
    if (msg === 'WEBMAIL_CREDENTIALS_UNREADABLE') {
      return { error: 'WEBMAIL_AUTH_FAILED', detail: 'Stored mail credentials could not be read — the user should reconnect the mailbox.' };
    }
    if (msg === 'WEBMAIL_ORIGINAL_NOT_FOUND') {
      return { error: 'EMAIL_NOT_FOUND', detail: 'Could not open the original email to reply to — list the inbox again to get a current uid.' };
    }
    if (msg === 'WEBMAIL_HOST_NOT_FOUND' || msg === 'WEBMAIL_CONNECTION_FAILED') {
      // Reading and sending fail differently here: IMAP works from this host,
      // outbound SMTP is blocked by it. Saying which one matters.
      if (name === 'send_business_email') {
        return {
          error: 'WEBMAIL_SEND_BLOCKED',
          detail: 'The email was NOT sent. This server cannot reach the outgoing mail server — reading the inbox still works, but replies from this address are not possible yet.',
        };
      }
      return { error: 'WEBMAIL_UNREACHABLE', detail: 'The mail server did not respond.' };
    }
    if (msg === 'WEBMAIL_SENDER_UNVERIFIED') {
      return { error: 'WEBMAIL_SENDER_UNVERIFIED', detail: "The sending service hasn't verified this business address/domain yet — the email was NOT sent. It needs finishing in the Brevo setup (domain authentication)." };
    }
    if (msg === 'WEBMAIL_SEND_KEY_INVALID') {
      return { error: 'WEBMAIL_SEND_FAILED', detail: 'The email sending service rejected the API key — the email was NOT sent. It needs reconnecting.' };
    }
    if (msg === 'WEBMAIL_SEND_FAILED') {
      return { error: 'WEBMAIL_SEND_FAILED', detail: 'The email could not be sent just now — nothing went out.' };
    }
    return { error: msg };
  }
}

module.exports = { executeWebmailTool };
