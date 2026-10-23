'use strict';

const t = require('../utils/time');

const gmail = require('../services/gmail');
const contactsRepo = require('../db/contacts');
const googleAuth = require('../auth/googleAuth');

/** Pull a bare email address out of a "Name <addr>" header, else return as-is. */
function extractAddress(from) {
  if (!from) return '';
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Execute a single Gmail tool_use block. Returns a plain object that is sent
 * back to Claude as the tool_result. Never throws — errors become {error}.
 *
 * @param {Object} user
 * @param {{name:string, input:Object}} toolUse
 */
async function executeGmailTool(user, toolUse) {
  if (!googleAuth.isEmailConnected(user)) {
    return { error: 'EMAIL_NOT_CONNECTED' };
  }

  const { name, input } = toolUse;
  try {
    switch (name) {
      case 'find_contact': {
        const c = contactsRepo.find(user.id, input.query || '');
        if (c && c.email) {
          return { found: true, name: c.name || null, email: c.email };
        }
        // No stored contact — offer the user's top contacts as hints.
        const top = contactsRepo.topContacts(user.id, { limit: 5 })
          .filter((x) => x.email)
          .map((x) => ({ name: x.name, email: x.email }));
        return { found: false, suggestions: top };
      }

      case 'list_recent_emails': {
        const limit = Math.min(Math.max(parseInt(input.limit, 10) || 8, 1), 20);
        const tz = user.timezone || 'Asia/Karachi';
        // Inbox only unless they asked for something else (no filter used to
        // mix in SENT mail and drafts, so "latest email" was often their own).
        const raw = String(input.query || '').trim();
        const query = /\bin:|\blabel:|\bis:sent|\bin:sent/i.test(raw) ? raw : `in:inbox ${raw}`.trim();
        // Every linked Google account → one merged inbox, newest first.
        const accounts = gmail.accountsFor(user);
        const emails = [];
        const failed = [];
        for (const account of accounts) {
          try {
            const ids = await gmail.listMessageIds(user, { maxResults: limit, query, account });
            const metas = await Promise.all(ids.slice(0, limit).map((id) => gmail.getMessageMeta(user, id, account).catch(() => null)));
            for (const m of metas.filter(Boolean)) {
              const labels = m.labelIds || [];
              emails.push({
                id: m.gmailId,
                mailbox: 'gmail',
                account: account ? account.email : null,
                from: m.sender,
                subject: m.subject,
                snippet: (m.snippet || '').slice(0, 200),
                received_at: m.receivedAt,
                received: m.receivedAt ? `${t.dayLabel(m.receivedAt, tz)} ${t.timeLabel(m.receivedAt, tz)}` : null,
                unread: labels.includes('UNREAD'),
                category: labels.includes('CATEGORY_PROMOTIONS') ? 'promotions'
                  : labels.includes('CATEGORY_SOCIAL') ? 'social'
                    : labels.includes('CATEGORY_UPDATES') ? 'updates' : 'primary',
              });
            }
          } catch (err) {
            const gc = require('../services/googleConnection');
            const who = (account && account.email) || 'primary';
            console.warn(`[gmail] list failed for ${who}:`, err.message);
            if (gc.isAuthError(err)) {
              failed.push(who);
              await gc.markBroken(user, { account, reason: err.message });
            } else {
              failed.push(who);
            }
          }
        }
        if (!emails.length && failed.length) {
          return {
            error: 'GOOGLE_RECONNECT_NEEDED',
            detail: 'Gmail could not be reached — the Google connection has expired. Do NOT say there are no new emails. Tell the user in one line and send the Google connect link.',
            accounts: failed,
          };
        }
        emails.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
        const linked = accounts.map((a) => (a ? a.email : null)).filter(Boolean);
        return {
          mailbox: 'gmail (personal / Google accounts)',
          now: `${t.dayLabel(new Date(), tz)} ${t.timeLabel(new Date(), tz)}`,
          count: emails.length,
          accounts: linked,
          ...(failed.length ? { accounts_not_reachable: failed, note: 'Some Google accounts could not be read (connection expired) — say so.' } : {}),
          emails: emails.slice(0, limit),
          order: 'newest first; "received" is in the user\'s timezone — use it for when/latest',
        };
      }

      case 'read_email': {
        for (const account of gmail.accountsFor(user)) {
          try {
            const m = await gmail.getMessage(user, input.email_id, account);
            return {
              found: true,
              id: m.gmailId,
              account: account ? account.email : null,
              from: m.sender,
              subject: m.subject,
              received: m.receivedAt ? `${t.dayLabel(m.receivedAt, user.timezone || 'Asia/Karachi')} ${t.timeLabel(m.receivedAt, user.timezone || 'Asia/Karachi')}` : null,
              body: m.body,
              attachments: m.attachments || [],
            };
          } catch (_) { /* try the next account */ }
        }
        return { found: false, error: 'EMAIL_NOT_FOUND', detail: 'That message was not found in any connected mailbox.' };
      }

      case 'send_email': {
        const to = (input.to || '').trim();
        if (!EMAIL_RE.test(to)) {
          return { error: 'INVALID_RECIPIENT', detail: `"${to}" is not a valid email address. Use find_contact or ask the user for the address.` };
        }
        await gmail.sendMessage(user, {
          to,
          subject: input.subject || '(no subject)',
          body: input.body || '',
        });
        // Keep the CRM warm so future "who did I email" answers stay accurate.
        try { contactsRepo.recordInteraction(user.id, { email: to, at: new Date().toISOString() }); } catch (_) {}
        return { sent: true, to, subject: input.subject || '(no subject)' };
      }

      case 'reply_to_email': {
        // The message may live in any linked mailbox — find the account that
        // actually holds it so the reply is sent from the right address.
        let account = null;
        let original = null;
        for (const candidate of gmail.accountsFor(user)) {
          try {
            original = await gmail.getMessage(user, input.email_id, candidate);
            account = candidate;
            break;
          } catch (_) { /* try the next account */ }
        }
        if (!original) return { error: 'EMAIL_NOT_FOUND', detail: 'That message was not found in any connected mailbox.' };
        const to = extractAddress(original.sender);
        if (!EMAIL_RE.test(to)) {
          return { error: 'REPLY_TARGET_UNKNOWN', detail: 'Could not determine the original sender address.' };
        }
        const subject = /^re:/i.test(original.subject || '')
          ? original.subject
          : `Re: ${original.subject || ''}`.trim();
        await gmail.sendMessage(user, {
          to,
          subject,
          body: input.body || '',
          threadId: original.threadId,
          account,
        });
        try { contactsRepo.recordInteraction(user.id, { email: to, at: new Date().toISOString() }); } catch (_) {}
        try { require('../db/emailItems').markReplied(user.id, input.email_id); } catch (_) { /* best effort */ }
        return { sent: true, to, subject };
      }

      case 'forward_email': {
        const to = String(input.to || '').trim();
        if (!EMAIL_RE.test(to)) return { error: 'INVALID_RECIPIENT', detail: `"${input.to}" is not a valid email address.` };

        // Find which mailbox holds the message, then forward from that account.
        let account = null;
        for (const candidate of gmail.accountsFor(user)) {
          try { await gmail.getMessage(user, input.email_id, candidate); account = candidate; break; }
          catch (_) { /* try the next account */ }
        }
        if (account === null && gmail.accountsFor(user).length) return { error: 'EMAIL_NOT_FOUND', detail: 'That message was not found in any connected mailbox.' };

        const r = await gmail.forwardMessage(user, { messageId: input.email_id, to, note: input.note || '', account });
        try { contactsRepo.recordInteraction(user.id, { email: to, at: new Date().toISOString() }); } catch (_) {}
        return { forwarded: true, to, subject: r.subject, attachments_included: r.attachmentsForwarded };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err && err.message ? err.message : 'gmail_operation_failed';
    if (/insufficient|scope|permission/i.test(msg)) {
      return { error: 'EMAIL_SCOPE_MISSING', detail: 'Gmail send permission was not granted. The user should reconnect Google and allow sending email.' };
    }
    return { error: msg };
  }
}

module.exports = { executeGmailTool };
