'use strict';

/**
 * Send a user's email through THEIR OWN mail server via the Cloudflare SMTP
 * relay (relay/smtp-relay-worker.js).
 *
 * DigitalOcean blocks outbound SMTP from the droplet, so we can't talk to the
 * user's SMTP server directly. We build the finished message here, POST it over
 * HTTPS to the relay, and the relay logs in to the user's SMTP server (465/587)
 * and delivers it — so it truly goes out from their mailbox. We then drop a copy
 * in their Sent folder over IMAP (which the droplet can reach).
 *
 * Config: SMTP_RELAY_URL + SMTP_RELAY_SECRET. Off when either is missing.
 */

const config = require('../config');

const TIMEOUT_MS = 35000;

function enabled() {
  return !!(config.smtpRelay.url && config.smtpRelay.secret);
}

async function post(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(config.smtpRelay.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': config.smtpRelay.secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`RELAY:${err && err.name === 'AbortError' ? 'timeout' : 'unreachable'}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (res.status === 403) throw new Error('RELAY:forbidden (SMTP_RELAY_SECRET does not match the Worker)');
    throw new Error(`RELAY:${data.stage || 'error'}:${data.code || ''}:${data.error || `http_${res.status}`}`);
  }
  return data;
}

/** Deliver a finished RFC 822 message. s = settingsFor(user). */
async function deliver(s, { from, to, raw }) {
  return post({
    host: s.smtpHost, port: s.smtpPort, secure: Number(s.smtpPort) === 465, user: s.address, pass: s.password,
    from, to: Array.isArray(to) ? to : [to], raw,
  });
}

/** Only check that the SMTP login works (used when connecting a mailbox). */
async function verify(s) {
  return post({ host: s.smtpHost, port: s.smtpPort, secure: Number(s.smtpPort) === 465, user: s.address, pass: s.password, verify: true });
}

/** Turn a relay failure into the webmail error codes the tools already know. */
function classify(err) {
  const msg = String((err && err.message) || err || '');
  if (!/^RELAY:/.test(msg)) return null;
  const [, stage = '', code = ''] = msg.split(':');
  if (stage === 'auth' || code === '535' || code === '534') return 'WEBMAIL_AUTH_FAILED';
  if (stage === 'connect' || stage === 'timeout' || stage === 'starttls' || /unreachable|timeout/.test(stage)) return 'WEBMAIL_CONNECTION_FAILED';
  if (stage === 'forbidden (SMTP_RELAY_SECRET does not match the Worker)') return 'WEBMAIL_SEND_FAILED';
  if (stage === 'rcpt_to') return 'WEBMAIL_RECIPIENT_REJECTED';
  return 'WEBMAIL_SEND_FAILED';
}

module.exports = { enabled, deliver, verify, classify };
