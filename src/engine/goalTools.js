'use strict';

const goalTools = [
  {
    name: 'create_goal',
    description:
      'Create a longer-term GOAL the user wants to work toward (NOT a one-off task). Use for ' +
      '"my goal is to…", "I want to learn/save/build/lose…", "help me achieve…". Wingman builds an ' +
      'action plan and proactively coaches them toward it over days/weeks. For a single to-do, use create_task instead.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short goal title, e.g. "Learn to play tennis".' },
        detail: { type: 'string', description: 'Optional extra context the user gave.' },
        target_date: { type: 'string', description: 'Optional target date (ISO or natural) they want it done by.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_goals',
    description: 'List the user\'s goals with progress. Use for "my goals", "how am I doing on my goals".',
    input_schema: {
      type: 'object',
      properties: {
        include_finished: { type: 'boolean', description: 'Include done/dropped goals too.' },
      },
      required: [],
    },
  },
  {
    name: 'update_goal_progress',
    description:
      'Record progress on a goal — mark a plan step done, or set overall progress %. Use when the user ' +
      'reports progress ("signed up for tennis", "saved 10k this month"), or replies "done" to a goal nudge ' +
      '(then next_step_done: true). Only say it is done when steps_marked_done comes back non-empty.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal title or distinctive phrase to match.' },
        step: { type: 'string', description: 'A plan step they completed (text to match). Optional.' },
        next_step_done: { type: 'boolean', description: 'True when they say "done" to the next step you nudged them about — marks the first unfinished step.' },
        progress: { type: 'number', description: 'Overall progress 0-100. Optional.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'complete_goal',
    description: 'Mark a goal achieved (done) or abandon it (dropped). Use when the user says a goal is finished or wants to drop it.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal title or distinctive phrase to match.' },
        dropped: { type: 'boolean', description: 'True if abandoning rather than achieving it.' },
      },
      required: ['goal'],
    },
  },
];

const goalToolNames = new Set(goalTools.map((t) => t.name));

module.exports = { goalTools, goalToolNames };
