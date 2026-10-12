'use strict';

/**
 * Lets the user change how Wingman sounds without leaving the chat —
 * "use a male voice", "female voice mein baat karo", "stop sending voice notes".
 */
const voiceTools = [
  {
    name: 'set_voice',
    description:
      'Change the voice Wingman speaks in, or turn spoken replies on/off. ' +
      'Use when the user asks for a male/female voice, or asks you to stop or ' +
      'start replying with voice notes. Confirm the change afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        voice: {
          type: 'string',
          description:
            "Which voice to speak in: 'male', 'female' or 'neutral', or a style the user asked for " +
            "('british', 'deep', 'soft', 'formal'), or a voice name: wingman (Wingman's own voice, the default — use for 'normal'/'default'/'back to your voice'), george (British male), " +
            'daniel (British male, formal), brian (deep male), matilda (warm female), sarah (soft female), ' +
            'alice (British female), river (neutral).',
        },
        replies: {
          type: 'string',
          enum: ['off', 'on_voice', 'always'],
          description:
            "When to send voice notes: 'off' never, 'on_voice' only when the user " +
            "sends voice (the default), 'always' every reply.",
        },
      },
      required: [],
    },
  },
];

voiceTools.push({
  name: 'set_assistant_name',
  description:
    'Rename yourself when the user asks to call you something else ' +
    '("I want to call you Jarvis", "tumhara naam X rakh do"). ' +
    'Confirm warmly in your new name afterwards.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The new name, e.g. "Jarvis".' },
    },
    required: ['name'],
  },
});

const voiceToolNames = new Set(voiceTools.map((t) => t.name));

module.exports = { voiceTools, voiceToolNames };
