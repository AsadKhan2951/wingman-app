'use strict';

const claude = require('../llm/claude');

// When the user has told Wingman what matters to them, this block asks the model
// to ALSO act as their chief of staff: decide whether THIS email is worth a
// proactive WhatsApp ping, and if so write that ping in Wingman's own voice.
function priorityBlock(context) {
  const ctx = String(context || '').trim();
  if (!ctx) {
    return 'The user has NOT set email priorities, so set "notify": false and "notify_message": "".';
  }
  return `You are this user's AI chief of staff. Here, in their own words, is what matters to them for email — the people, topics and situations they want to be told about:
"""
${ctx.slice(0, 1500)}
"""
Using ONLY these priorities, decide "notify": should Wingman message the user on WhatsApp about THIS email right now? Be selective — say true only when it genuinely matches what they care about (an important person, an important topic, a query/decision/reply they'd want to know about). Routine, promotional or FYI mail → false.
If true, write "notify_message": a short, natural WhatsApp note FROM Wingman TO the user (first person, warm, concise) that says who it's from, what they want, and what you'd suggest — then offer to help or draft a reply. Example tone: "📧 <name> emailed about <topic> — they're asking <what>. Want me to draft a reply?" Keep it to 2–4 lines. If notify is false, set notify_message to "".`;
}

const ANALYSIS_PROMPT = (subject, sender, body, context) => `Analyze this email. Respond ONLY in valid JSON, no markdown, no backticks:
{
  "category": "urgent|needs_reply|fyi|spam",
  "summary": "1-2 sentence summary",
  "action_needed": true or false,
  "detected_type": "bill|payment_receipt|order|cancellation|flight|meeting_request|general",
  "extracted_data": {
    "company": "if bill or payment_receipt: company/biller name",
    "amount": "if bill or payment_receipt: amount with currency",
    "due_date": "if bill: YYYY-MM-DD",
    "item": "if order: item name",
    "store": "if order: store name",
    "tracking_number": "if order: tracking number or null",
    "carrier": "if order: carrier name or null",
    "eta": "if order: estimated delivery date or null",
    "airline": "if flight: airline name",
    "flight_number": "if flight: flight number",
    "departure": "if flight: departure city/airport",
    "arrival": "if flight: arrival city/airport",
    "flight_date": "if flight: YYYY-MM-DD",
    "flight_time": "if flight: HH:MM"
  },
  "draft_reply": "suggested reply text if action_needed, null otherwise",
  "notify": true or false,
  "notify_message": "the WhatsApp note to send the user, or empty string"
}

detected_type guidance:
- "bill" = an invoice/statement the user still needs to PAY (has an amount due and usually a due date).
- "cancellation" = something was CANCELLED: an order, booking, flight, subscription, meeting or appointment (words like "cancelled", "cancellation", "has been canceled", "refund issued for your cancelled…").
- "payment_receipt" = confirmation a payment ALREADY went through (words like "payment received", "receipt", "thank you for your payment", "your card was charged"). Set company and amount so the matching bill can be cleared. Do NOT mark these as "bill".

${priorityBlock(context)}

Email subject: ${subject}
Email from: ${sender}
Email body: ${body}`;

/**
 * Strip code fences / stray prose and parse JSON safely.
 */
function parseJson(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  // Grab the outermost {...} if there is extra text around it
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

/**
 * Analyze one email via Claude. Returns a normalized object; on failure,
 * returns a safe "fyi/general" fallback so the scan never crashes.
 *
 * @param {{subject:string, sender:string, body:string}} email
 */
async function analyzeEmail(email, { context = '' } = {}) {
  const prompt = ANALYSIS_PROMPT(
    email.subject || '(no subject)', email.sender || '(unknown)', email.body || '', context,
  );
  try {
    const raw = await claude.complete(prompt, { maxTokens: 900, model: require('../config').anthropic.modelCheap });
    const parsed = parseJson(raw);
    return {
      category: ['urgent', 'needs_reply', 'fyi', 'spam'].includes(parsed.category) ? parsed.category : 'fyi',
      summary: parsed.summary || '',
      actionNeeded: !!parsed.action_needed,
      detectedType: parsed.detected_type || 'general',
      extractedData: parsed.extracted_data || {},
      draftReply: parsed.draft_reply || null,
      // Context-aware proactive-notify decision (only set when context was given).
      notify: !!parsed.notify,
      notifyMessage: parsed.notify_message || '',
    };
  } catch (err) {
    return {
      category: 'fyi',
      summary: (email.subject || '').slice(0, 140),
      actionNeeded: false,
      detectedType: 'general',
      extractedData: {},
      draftReply: null,
      notify: false,
      notifyMessage: '',
      _error: err.message,
    };
  }
}

module.exports = { analyzeEmail, ANALYSIS_PROMPT, parseJson };
