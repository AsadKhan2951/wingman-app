'use strict';

/**
 * Business-email tools (IMAP/SMTP). Separate from the Gmail tools because this
 * is typically the address customers actually write to — info@company.com —
 * and the user wants to read and answer it from WhatsApp.
 */
const webmailTools = [
  {
    name: 'list_business_emails',
    description:
      "List recent messages in the user's connected business mailbox (their " +
      'company address, e.g. info@company.com — NOT their Gmail). Use for ' +
      '"any customer emails?", "check the business inbox", or before replying to a customer.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many messages (default 10, max 25).' },
      },
      required: [],
    },
  },
  {
    name: 'read_business_email',
    description:
      'Open ONE business email in full (headers + body text) by its uid, so you can ' +
      'summarise what it actually says or write an informed reply. Get the uid from ' +
      'list_business_emails first. Use for "read the latest one", "what does that email say?", ' +
      'or before replying to a customer.',
    input_schema: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: 'The uid of the message (from list_business_emails).' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'send_business_email',
    description:
      "Send a NEW email FROM the user's business address (their company mailbox). " +
      'Use when they want to write to a customer from the business email rather than ' +
      'their personal Gmail. For answering an email they received, prefer reply_business_email. ' +
      'Only send when they have clearly asked you to send. Write the full body yourself.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Subject line.' },
        body: { type: 'string', description: 'Full plain-text body, written AS the user — their greeting, tone, length and sign-off.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'reply_business_email',
    description:
      'Reply to a business email the user RECEIVED, from their business address. Fetches the ' +
      'original by uid and sends your reply to its sender with the right "Re:" subject and threading — ' +
      'you only supply the body. Use for "reply to that", "reply to the one from X", "answer this customer". ' +
      'Only send once the user has clearly asked you to send.',
    input_schema: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: 'The uid of the message to reply to (from list_business_emails).' },
        body: { type: 'string', description: 'Full plain-text reply body, written AS the user — their greeting, tone, length and sign-off.' },
      },
      required: ['uid', 'body'],
    },
  },
];

const webmailToolNames = new Set(webmailTools.map((t) => t.name));

module.exports = { webmailTools, webmailToolNames };
