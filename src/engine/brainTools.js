'use strict';

/**
 * Tools for the "judgement" layer: the user's standing rules about when Wingman
 * should act, ask, tell them, or stay quiet — plus re-studying a connected app.
 */

const brainTools = [
  {
    name: 'set_rule',
    description:
      'Save a standing rule the user just gave you about how to behave from now on. Use when they say things ' +
      'like "don\'t ask me every time for this", "is ke liye mat poocho", "always check with me before …", ' +
      '"stop telling me about …", "aisi cheezen mat batao", "always tell me when …". ' +
      'kind = auto_approve (a specific app action may run without asking — give app and the exact CAPITALS ' +
      'tool name; the user must confirm this rule once with a yes) · always_ask (always get a yes before ' +
      'something) · notify_mute (don\'t proactively tell them about something) · notify_always (always tell ' +
      'them about something) · behavior (HOW you should talk or act from now on — any correction of your tone, ' +
      'length, language, format, wording or habits: "too long", "chhota likho", "no emojis", "don\'t call me sir", ' +
      '"always reply in Roman Urdu", "stop summarising at the end", "in emails never say sorry for the delay"). ' +
      'Save a behavior rule THE MOMENT they correct you, even if they only grumble ("itna lamba kyun?"), then follow it. ' +
      'Write "about" as a short, specific instruction in English, e.g. "Keep replies to 2-3 short lines".',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['auto_approve', 'always_ask', 'notify_mute', 'notify_always', 'behavior'] },
        about: { type: 'string', description: 'What the rule covers, e.g. "Posting to the Wingman Posting Facebook page" or "Newsletter and promotional emails".' },
        app: { type: 'string', description: 'For auto_approve: the app slug, e.g. "slack", "facebook".' },
        tool: { type: 'string', description: 'For auto_approve: the exact CAPITALS tool name, e.g. "SLACK_SEND_MESSAGE".' },
      },
      required: ['kind', 'about'],
    },
  },
  {
    name: 'grant_autonomy',
    description:
      'The user just said YES to your offer to do a kind of action without asking from now on (the offer came back as ' +
      'autonomy_offer on an approved action). Saves it. Only for an offer you actually made — never on your own.',
    input_schema: {
      type: 'object',
      properties: { offer_key: { type: 'string', description: 'The offer_key from autonomy_offer.' } },
      required: ['offer_key'],
    },
  },
  {
    name: 'list_rules',
    description: 'List the standing rules the user has given you. Use when they ask what rules/permissions you have.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_rule',
    description: 'Remove a standing rule when the user takes it back ("ask me again for posts", "you can tell me about X again").',
    input_schema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: 'The id from list_rules.' },
        about: { type: 'string', description: 'Or a word/phrase identifying the rule.' },
      },
    },
  },
  {
    name: 'restudy_app',
    description:
      'Study one of the user\'s connected apps again right now and refresh your notes about it. Use when they ' +
      'say your picture of it is outdated or wrong, or ask you to look at it again. Takes a few minutes in the background.',
    input_schema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'App slug, e.g. "shopify", "slack", "facebook".' } },
      required: ['app'],
    },
  },
  {
    name: 'set_briefing_call',
    description:
      'Turn the user\'s voice briefings on or off: at their briefing and wrap times Wingman calls them on WhatsApp ' +
      'and talks it through (and sends the briefing as a voice note too when a call is missed). Use when they ask to ' +
      'be called / not called for their briefing, to "call me again", or for voice briefings in any wording.',
    input_schema: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true to turn voice briefings on, false to turn them off.' } },
      required: ['on'],
    },
  },
];

const brainToolNames = new Set(brainTools.map((t) => t.name));

module.exports = { brainTools, brainToolNames };
