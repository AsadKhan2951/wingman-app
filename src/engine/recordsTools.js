'use strict';

/**
 * Tools for the things Wingman tracks on the user's behalf — bills, deliveries,
 * trips, the people they deal with, and the inbox digest.
 *
 * These used to be reachable only through English keyword shortcuts in
 * conversation.js ("any bills due", "where's my order"), which misfired on real
 * requests and never matched Roman Urdu. As tools, the assistant decides when
 * they apply — in any language, inside any larger request.
 */

const recordsTools = [
  {
    name: 'search_user_data',
    description:
      'Search EVERYTHING Wingman has on this user in one go — their emails (subject, sender, AI summary), meetings ' +
      '(notes, transcripts, summaries, decisions, action items), calendar events, tasks, contacts, follow-ups/promises, ' +
      'and your own past chats with them. Use it FIRST for anything about the past or "what do we know about…": ' +
      '"what did the client say last month", "Ali ke saath kya tay hua tha", "when did we discuss pricing", "find the ' +
      'invoice email", "what did I tell you about my trip". Write the query in English keywords + names (the data is ' +
      'mostly English), e.g. "Ali pricing proposal". Use since/until (YYYY-MM-DD) for time ranges like "last month". ' +
      'Results give source + ref_id; open one fully with open_user_record. For live/new data (today\'s inbox, a ' +
      'just-arrived email) use the live tools instead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords and names to look for. Can be empty when only a date range matters.' },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['email', 'meeting', 'event', 'task', 'contact', 'followup', 'chat'] },
          description: 'Limit to these kinds of data (omit to search all).',
        },
        since: { type: 'string', description: 'Only items on/after this date, YYYY-MM-DD.' },
        until: { type: 'string', description: 'Only items on/before this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'How many results (default 8, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'open_user_record',
    description: 'Open one result from search_user_data in full (the whole meeting summary/notes, the email summary, the chat message…). For an email it also returns gmail_id, so read_email can fetch the original if needed.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['email', 'meeting', 'event', 'task', 'contact', 'followup', 'chat'] },
        ref_id: { type: 'string' },
      },
      required: ['source', 'ref_id'],
    },
  },
  {
    name: 'list_bills',
    description: 'The user\'s pending bills with amounts and due dates. Use for any question about bills, dues, what they owe, what is coming up to pay.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_bill_paid',
    description: 'Mark one of the user\'s bills as paid when THEY say they paid it ("paid K-Electric", "PTCL ka bill de diya"). Only records it — it does not pay anything.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Biller / bill name, e.g. "K-Electric".' } },
      required: ['name'],
    },
  },
  {
    name: 'list_deliveries',
    description: 'The user\'s active orders/parcels with status, carrier and ETA. Use for "where is my order", "mera parcel kahan hai", any delivery or tracking question.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_trips',
    description: 'The user\'s upcoming trips (found from their email). Use for any question about travel plans or upcoming trips.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'trip_itinerary',
    description: 'Full itinerary for one of the user\'s trips — flights, hotel, weather at the destination.',
    input_schema: {
      type: 'object',
      properties: { destination: { type: 'string', description: 'City or destination of the trip, e.g. "Dubai".' } },
      required: ['destination'],
    },
  },
  {
    name: 'trip_cost',
    description: 'What one of the user\'s trips cost (from the bookings on record).',
    input_schema: {
      type: 'object',
      properties: { destination: { type: 'string', description: 'City or destination of the trip.' } },
      required: ['destination'],
    },
  },
  {
    name: 'city_weather',
    description: 'Current weather and short forecast for a city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  {
    name: 'contact_info',
    description: 'What Wingman has on record about a person the user deals with — email, how often they are in touch, last contact, notes. Use for "what do I know about X", "X kaun hai", or before writing to someone.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Person\'s name or email.' } },
      required: ['name'],
    },
  },
  {
    name: 'top_contacts',
    description: 'The people the user has been in touch with the most (this month, else overall).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'inbox_digest',
    description: 'A ready digest of the user\'s recent email, grouped by urgent / needs reply / FYI, as Wingman has already analysed it. Use for a quick "anything in my inbox?" — for a specific email, search or reply, use the email tools instead.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'email_overview',
    description:
      'The same email list the Wingman app shows, from BOTH Gmail and the business mailbox, already analysed: ' +
      'who it is from, when it arrived (user timezone), a one-line summary, whether it needs a reply, its type ' +
      '(order, cancellation, bill, payment receipt, flight, meeting request…) and whether it was replied. Newest first. ' +
      'Use for "pending emails", "which emails need a reply", "any cancellation / order / bill emails", "emails from Hemani", ' +
      '"what came in today", and whenever the user asks about something they saw in the app. For the live latest inbox use list_recent_emails / list_business_emails.',
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['needs_reply', 'urgent', 'handled', 'all'], description: 'needs_reply = still waiting on the user (the app\'s "Needs reply"). Default all.' },
        type: { type: 'string', description: 'Optional email type: order, cancellation, bill, payment_receipt, flight, meeting_request, general.' },
        mailbox: { type: 'string', enum: ['gmail', 'business', 'all'], description: 'Default all.' },
        search: { type: 'string', description: 'Optional word/name to match in sender, subject or summary (e.g. "Hemani", "cancel").' },
        since_days: { type: 'number', description: 'Only emails from the last N days.' },
        limit: { type: 'number', description: 'Default 15, max 40.' },
      },
    },
  },
  {
    name: 'needs_attention',
    description:
      'What the app\'s Home "Needs attention" card shows: overdue tasks, emails still waiting on a reply, and today\'s ' +
      'calendar clashes — each with details. Use for "what needs my attention", "kya pending hai", "44 need you kya hai", "what am I behind on".',
    input_schema: { type: 'object', properties: {} },
  },
];

const recordsToolNames = new Set(recordsTools.map((t) => t.name));

module.exports = { recordsTools, recordsToolNames };
