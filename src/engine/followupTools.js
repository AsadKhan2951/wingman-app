'use strict';

/**
 * Tools for the meeting follow-up agent (services/meetingFollowup.js): book the
 * follow-up Wingman proposed after a meeting, or drop it.
 */
const followupTools = [
  {
    name: 'list_meeting_followups',
    description: 'List follow-up meetings Wingman proposed after recent meetings that are still waiting for the user (open points, attendees, proposed time). Use for "what was left open from my meetings?" or before scheduling one.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_meeting_followup',
    description: 'Book a proposed meeting follow-up on the user\'s Google Calendar, inviting everyone from the original meeting (Google emails them the invite) with the open points as the agenda. Call ONLY after the user agreed to that follow-up ("yes", "haan", "kar do") or asked for it. Pass start_time if they chose a different time.',
    input_schema: {
      type: 'object',
      properties: {
        followup_id: { type: 'string', description: 'From the MEETING FOLLOW-UPS block or list_meeting_followups.' },
        start_time: { type: 'string', description: 'Optional ISO 8601 start with the user\'s offset, if they picked another time.' },
        duration_minutes: { type: 'number', description: 'Optional, default 30.' },
        note: { type: 'string', description: 'Optional one-line note for the invite.' },
      },
      required: ['followup_id'],
    },
  },
  {
    name: 'dismiss_meeting_followup',
    description: 'Drop a proposed meeting follow-up when the user says it is not needed.',
    input_schema: {
      type: 'object',
      properties: { followup_id: { type: 'string' } },
      required: ['followup_id'],
    },
  },
];

const followupToolNames = new Set(followupTools.map((t) => t.name));

async function executeFollowupTool(user, { name, input = {} }, ctx = {}) {
  const fu = require('../services/meetingFollowup');
  try {
    if (name === 'list_meeting_followups') {
      const tz = user.timezone || 'Asia/Karachi';
      const t = require('../utils/time');
      return {
        followups: fu.listPending(user.id).map((p) => ({
          followup_id: p.id,
          title: p.title,
          open_points: p.items,
          with: p.attendees.map((a) => `${a.name} <${a.email}>`),
          proposed: p.proposed_start ? `${t.dayLabel(p.proposed_start, tz)} ${t.timeLabel(p.proposed_start, tz)}` : null,
        })),
      };
    }
    if (name === 'schedule_meeting_followup') {
      // Invites go to other people — never from an automated run.
      if (ctx.automated) return { error: 'NEEDS_USER_CONFIRMATION', detail: 'Only the user can approve sending invites.' };
      return await fu.schedule(user, String(input.followup_id || ''), {
        startTime: input.start_time, durationMin: input.duration_minutes, note: input.note,
      });
    }
    if (name === 'dismiss_meeting_followup') return fu.dismiss(user, String(input.followup_id || ''));
    return { error: 'UNKNOWN_TOOL' };
  } catch (e) {
    return { error: 'FOLLOWUP_ERROR', detail: String(e.message || '').slice(0, 200) };
  }
}

module.exports = { followupTools, followupToolNames, executeFollowupTool };
