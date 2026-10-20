'use strict';

/**
 * Tools for replies Wingman drafted in the user's voice (services/replyDrafter).
 * Sending goes through the same approval gate as any reply — and the user's
 * earned "do without asking" rules.
 */
const replyTools = [
  {
    name: 'list_prepared_replies',
    description: 'Emails waiting on the user for which you have ALREADY drafted a reply in their voice. Use for "kis ko jawab dena hai?", "pending emails", "show me the replies", or when they ask what needs them.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_prepared_reply',
    description: 'Show the full drafted reply for one email (email_item_id from list_prepared_replies or the REPLIES block).',
    input_schema: { type: 'object', properties: { email_item_id: { type: 'string' } }, required: ['email_item_id'] },
  },
  {
    name: 'send_prepared_reply',
    description: 'Send a drafted reply when the user says send / bhej do / theek hai for it. Pass body only if they changed the draft or filled a [gap]. Goes through the normal approval step.',
    input_schema: {
      type: 'object',
      properties: {
        email_item_id: { type: 'string' },
        body: { type: 'string', description: 'The final text, if they edited it or you filled a [gap] with what they said.' },
      },
      required: ['email_item_id'],
    },
  },
];
const replyToolNames = new Set(replyTools.map((t) => t.name));

const GAP = /\[[^\]\n]{2,80}\]/;

async function executeReplyTool(user, { name, input = {} }, ctx = {}) {
  const emailItems = require('../db/emailItems');
  const drafter = require('../services/replyDrafter');
  const t = require('../utils/time');
  const tz = user.timezone || 'Asia/Karachi';
  const view = (r) => ({
    email_item_id: r.id,
    from: drafter.fromName(r.sender),
    subject: r.subject,
    mailbox: String(r.gmail_id || '').startsWith('webmail:') ? 'business' : 'gmail',
    received: r.received_at ? `${t.dayLabel(r.received_at, tz)} ${t.timeLabel(r.received_at, tz)}` : null,
    needs_from_user: r.prepared_note || null,
  });
  try {
    if (name === 'list_prepared_replies') {
      const rows = emailItems.listPrepared(user.id, 10);
      return rows.length ? { replies: rows.map(view) } : { replies: [], note: 'No drafted replies waiting.' };
    }
    const item = emailItems.getById(user.id, String(input.email_item_id || ''));
    if (!item) return { error: 'EMAIL_NOT_FOUND' };
    if (name === 'get_prepared_reply') {
      if (!item.prepared_reply) return { error: 'NO_DRAFT', detail: 'No draft for this one yet — write one with them.' };
      return { ...view(item), draft: item.prepared_reply };
    }
    if (name === 'send_prepared_reply') {
      if (item.replied) return { error: 'ALREADY_REPLIED' };
      const body = String(input.body || item.prepared_reply || '').trim();
      if (!body) return { error: 'NO_DRAFT' };
      if (GAP.test(body)) return { error: 'DRAFT_HAS_GAP', detail: `Ask them for: ${body.match(GAP)[0]} — then send with that filled in.` };
      const plan = drafter.sendPlan(item, body);
      const ie = require('./integrationExecutor');
      const runNow = async () => (plan.tool === 'reply_business_email'
        ? require('./webmailExecutor').executeWebmailTool(user, { name: plan.tool, input: plan.input })
        : require('./gmailExecutor').executeGmailTool(user, { name: plan.tool, input: plan.input }));
      const out = await ie.gateBuiltin(user, plan.tool, plan.input, ctx, runNow);
      if (out && !out.error && !out.approval_required) emailItems.markReplied(user.id, item.gmail_id);
      return out;
    }
    return { error: 'UNKNOWN_TOOL' };
  } catch (e) {
    return { error: 'REPLY_ERROR', detail: String(e.message || '').slice(0, 200) };
  }
}

module.exports = { replyTools, replyToolNames, executeReplyTool };
