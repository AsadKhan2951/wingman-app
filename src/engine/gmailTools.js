'use strict';

/**
 * Anthropic tool definitions for Gmail actions. Claude decides when to call
 * these; the engine executes them against the Gmail service (src/services/gmail.js).
 *
 * These give Wingman the ability to ACTUALLY send mail — not just draft it.
 * The engine guards on the user having connected Gmail (with gmail.send scope).
 */
const gmailTools = [
  {
    name: 'find_contact',
    description:
      'Look up a person the user knows, by name or partial email, to get their ' +
      'email address before sending mail. Use whenever the user names a recipient ' +
      '(e.g. "email Ali") but did not give a full email address.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "The person's name or partial email, e.g. \"Ali\" or \"fahad@\"." },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent_emails',
    description:
      "List the user's recent inbox emails (sender, subject, snippet, id) so you " +
      'can summarize them or pick one to reply to. Use for "any new emails?", ' +
      '"what\'s in my inbox?", or before replying to a specific message.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional Gmail search filter, e.g. "is:unread", "from:ali", "newer_than:2d". Omit for latest.',
        },
        limit: { type: 'number', description: 'How many to fetch (default 6, max 10).' },
      },
      required: [],
    },
  },
  {
    name: 'read_email',
    description:
      'Read one specific email in full, including readable attachment text ' +
      '(PDF, DOCX, XLSX, TXT, CSV, JSON, HTML, XML) when present. Use after ' +
      'list_recent_emails when the user wants details from a message or its attachment.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'The Gmail message id to read.' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'send_email',
    description:
      'Send a NEW email on the user\'s behalf. Call this ONLY when the user has ' +
      'clearly asked you to send (e.g. "send it", "email him", "bhej do"). ' +
      'Resolve the recipient to a real email address first (via find_contact or ' +
      'ask the user). After sending, confirm briefly.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (must be a valid address, not a name).' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body, written in full AS the user — their greeting, tone, length and sign-off (see WRITING EMAILS AS … in your instructions).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'reply_to_email',
    description:
      'Reply to a specific email already in the inbox, keeping it in the same ' +
      'thread. Get the email id from list_recent_emails first. Only send when the ' +
      'user explicitly asks you to reply/send.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'The Gmail message id to reply to (from list_recent_emails).' },
        body: { type: 'string', description: 'Plain-text reply body, written in full AS the user — their greeting, tone, length and sign-off.' },
      },
      required: ['email_id', 'body'],
    },
  },
  {
    name: 'forward_email',
    description:
      'Forward an existing email to someone else, keeping its attachments. Get ' +
      'the email id from list_recent_emails first, and resolve the recipient to a ' +
      'real address (find_contact or ask). Only send when the user clearly asks to forward.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'The Gmail message id to forward (from list_recent_emails).' },
        to: { type: 'string', description: 'Recipient email address (a real address, not a name).' },
        note: { type: 'string', description: 'Optional short note to add above the forwarded content.' },
      },
      required: ['email_id', 'to'],
    },
  },
];

const gmailToolNames = new Set(gmailTools.map((t) => t.name));

module.exports = { gmailTools, gmailToolNames };
