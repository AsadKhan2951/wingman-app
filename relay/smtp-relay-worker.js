/**
 * Wingman SMTP relay — a Cloudflare Worker.
 *
 * DigitalOcean blocks outbound SMTP (ports 25/465/587) from droplets, so the
 * Wingman server cannot hand a user's email to THEIR OWN mail server. Cloudflare
 * Workers can open TCP sockets on 465/587 (only port 25 is blocked), so the
 * server POSTs the finished message here and this Worker delivers it through
 * the user's own SMTP server, logged in as the user. The mail really goes out
 * FROM their mailbox — nothing is stored here.
 *
 * Deploy: Cloudflare → Workers & Pages → Create → Worker → paste this file →
 * Deploy. Then Settings → Variables and Secrets → add Secret RELAY_SECRET (the
 * same long random string as SMTP_RELAY_SECRET in the droplet .env).
 *
 * POST /  (header X-Relay-Secret)
 *   { host, port, secure?, user, pass, from, to: [..], raw }  → delivers raw (RFC 822)
 *   { host, port, secure?, user, pass, verify: true }          → only checks the login
 */
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();
const TIMEOUT_MS = 25000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function fail(stage, msg, code) {
  const e = new Error(msg);
  e.stage = stage;
  e.code = code || null;
  return e;
}

function b64(s) {
  let bin = '';
  for (const byte of enc.encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

class Smtp {
  constructor(sock) { this.attach(sock); }

  attach(sock) {
    this.sock = sock;
    this.reader = sock.readable.getReader();
    this.writer = sock.writable.getWriter();
    this.buf = '';
  }

  detach() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  async reply(stage) {
    const lines = [];
    for (;;) {
      let i;
      while ((i = this.buf.indexOf('\n')) < 0) {
        const { value, done } = await this.reader.read();
        if (done) throw fail(stage, 'connection closed by mail server');
        this.buf += dec.decode(value, { stream: true });
      }
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      lines.push(line);
      if (line.length < 4 || line[3] !== '-') {
        return { code: parseInt(line.slice(0, 3), 10), text: lines.join('\n') };
      }
    }
  }

  async write(s) { await this.writer.write(enc.encode(s)); }

  async cmd(line, expect, stage, shown) {
    await this.write(`${line}\r\n`);
    const r = await this.reply(stage);
    if (!expect.includes(r.code)) throw fail(stage, `${shown || line.split(' ')[0]} → ${r.text}`, r.code);
    return r;
  }
}

async function run({ host, port, secure, user, pass, from, to, raw, verify }) {
  port = Number(port) || 465;
  // TLS from the first byte (465) vs plain + STARTTLS (587). Explicit flag wins.
  const implicitTls = secure == null ? port === 465 : !!secure;
  const sock = connect({ hostname: host, port }, { secureTransport: implicitTls ? 'on' : 'starttls', allowHalfOpen: false });
  let active = sock;
  let c = new Smtp(sock);
  try {
    const greet = await c.reply('connect');
    if (greet.code !== 220) throw fail('connect', greet.text, greet.code);

    let ehlo = await c.cmd('EHLO wingman-relay', [250], 'ehlo');
    if (!implicitTls) {
      if (!/STARTTLS/i.test(ehlo.text)) throw fail('starttls', 'server does not offer STARTTLS on this port');
      await c.cmd('STARTTLS', [220], 'starttls');
      c.detach();
      active = sock.startTls({ expectedServerHostname: host });
      c = new Smtp(active);
      ehlo = await c.cmd('EHLO wingman-relay', [250], 'ehlo');
    }

    const authLine = (ehlo.text.match(/AUTH[ =]([^\n]*)/i) || [])[1] || 'PLAIN LOGIN';
    if (/PLAIN/i.test(authLine)) {
      await c.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], 'auth', 'AUTH PLAIN');
    } else {
      await c.cmd('AUTH LOGIN', [334], 'auth');
      await c.cmd(b64(user), [334], 'auth', 'username');
      await c.cmd(b64(pass), [235], 'auth', 'password');
    }

    if (verify) {
      await c.write('QUIT\r\n').catch(() => {});
      return { verified: true };
    }

    await c.cmd(`MAIL FROM:<${from}>`, [250], 'mail_from');
    const accepted = [];
    const rejected = [];
    for (const rcpt of to) {
      await c.write(`RCPT TO:<${rcpt}>\r\n`);
      const r = await c.reply('rcpt_to');
      (r.code === 250 || r.code === 251 ? accepted : rejected).push(r.code === 250 || r.code === 251 ? rcpt : `${rcpt}: ${r.text}`);
    }
    if (!accepted.length) throw fail('rcpt_to', `no recipient accepted — ${rejected.join('; ')}`);

    await c.cmd('DATA', [354], 'data');
    let body = String(raw).replace(/\r?\n/g, '\r\n');
    if (body.startsWith('.')) body = `.${body}`;
    body = body.replace(/\r\n\./g, '\r\n..');
    if (!body.endsWith('\r\n')) body += '\r\n';
    await c.write(`${body}.\r\n`);
    const done = await c.reply('data');
    if (done.code !== 250) throw fail('data', done.text, done.code);
    await c.write('QUIT\r\n').catch(() => {});
    return { accepted, rejected, response: done.text };
  } finally {
    try { await active.close(); } catch (_) { /* already closed */ }
  }
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('Wingman SMTP relay', { status: 200 });
    if (!env.RELAY_SECRET || !safeEqual(req.headers.get('x-relay-secret'), env.RELAY_SECRET)) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }
    let b;
    try { b = await req.json(); } catch (_) { return json({ ok: false, error: 'bad json' }, 400); }
    if (!b.host || !b.user || !b.pass) return json({ ok: false, error: 'host, user and pass are required' }, 400);
    if (Number(b.port) === 25) return json({ ok: false, stage: 'connect', error: 'port 25 is not allowed — use 465 or 587' }, 400);
    if (!b.verify) {
      b.to = (Array.isArray(b.to) ? b.to : [b.to]).filter(Boolean);
      if (!b.from || !b.to.length || !b.raw) return json({ ok: false, error: 'from, to and raw are required' }, 400);
    }
    try {
      const out = await Promise.race([
        run(b),
        new Promise((_, rej) => setTimeout(() => rej(fail('timeout', 'mail server took too long')), TIMEOUT_MS)),
      ]);
      return json({ ok: true, ...out });
    } catch (e) {
      return json({ ok: false, stage: e.stage || 'connect', code: e.code || null, error: String((e && e.message) || e) }, 502);
    }
  },
};
