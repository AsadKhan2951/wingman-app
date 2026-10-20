'use strict';

/**
 * Executes integration tool calls (see integrationTools.js).
 *
 * THE APPROVAL GATE (CORE-03) IS ENFORCED HERE, NOT IN THE PROMPT:
 *  - Read-only app tools (Composio tags them readOnlyHint) run immediately.
 *  - Every other app tool is parked in integration_actions as 'pending' and the
 *    model gets back { approval_required, action_id, preview } to show the user.
 *  - approve_integration_action only runs it if the user has sent a NEW message
 *    since it was proposed (rowid check) and it hasn't expired — so the model
 *    cannot approve its own proposal, and an automated run can never execute a
 *    write. There is no bypass flag and the user's autonomy setting does not
 *    skip it.
 * Never throws — errors come back as { error } so Claude can explain them.
 */

const config = require('../config');
const composio = require('../services/composio');
const actions = require('../db/integrationActions');
const agentActions = require('../db/agentActions');
const { managementToolNames, APPROVAL_TOOL_NAMES } = require('./integrationTools');

const DISCONNECT = '__DISCONNECT__';

// Steps that change nothing anyone can see: they only PREPARE something that a
// later, approval-gated call publishes. Instagram's "media container" is an
// unpublished draft that expires by itself — asking for a yes here AND at the
// publish step would mean two confirmations for one post. Keep this list tiny.
const PREP_NO_APPROVAL = new Set(['INSTAGRAM_POST_IG_USER_MEDIA', 'INSTAGRAM_CREATE_MEDIA_CONTAINER']);

// A user can tell Wingman "don't ask me for this" (an auto_approve rule) — but
// never for these. Money, deletion and anything that spends an ad budget always
// wait for a yes, whatever rule exists.
const RULE = '__RULE__';
const NEVER_AUTO = /(DELETE|REMOVE|DESTROY|PURGE|PAY|REFUND|CHARGE|TRANSFER|PURCHASE|CHECKOUT|CANCEL|REVOKE|BLOCK|BAN|UNINSTALL)/;
const NEVER_AUTO_APPS = new Set(['metaads', 'googleads', 'stripe', 'paypal']);

function canEverAutoApprove(toolkit, slug, meta) {
  if (!slug || slug === DISCONNECT || slug === RULE) return false;
  if (NEVER_AUTO_APPS.has(String(toolkit || '').toLowerCase())) return false;
  if (meta && meta.destructive) return false;
  return !NEVER_AUTO.test(String(slug).toUpperCase());
}

// ─── Built-in actions behind the same gate ──────────────────────────
// Gmail / business mail sends, cancelling calendar events and deleting or
// sharing Drive files are just as outward-facing as an app tool, so they go
// through this same server-side yes — the prompt alone is not a guarantee, and
// an automated run (whose text may come from an email or a web page) must
// never send mail on its own.
const BUILTIN = 'builtin';
const BUILTIN_GATED = new Set([
  'send_email', 'reply_to_email', 'forward_email',
  'send_business_email', 'reply_business_email',
  'delete_event', 'delete_drive_file', 'share_drive_file',
  // Spends money on the business Uber account.
  'book_ride', 'cancel_ride',
]);
// These must wait for a yes even when Composio (and so the approval table's
// usual path) is off: money is never spent without the user confirming.
const ALWAYS_CONFIRM = new Set(['book_ride', 'cancel_ride']);

// Built-ins that are only outward-facing for some inputs, or that persist
// instructions which later run on their own:
//  - create_event / update_event WITH attendees: Google emails the invite (and
//    the description) to those people.
//  - create_automation: a standing instruction that later runs unattended —
//    an instruction planted in an email/web page must not install itself.
function builtinNeedsYes(name, input = {}) {
  if (BUILTIN_GATED.has(name)) return true;
  if (name === 'create_event' || name === 'update_event') {
    return Array.isArray(input && input.attendees) && input.attendees.some((a) => String(a || '').trim());
  }
  return name === 'create_automation';
}

let builtinRunner = null;
/** conversation.js registers how to actually run a built-in tool after the yes. */
function setBuiltinRunner(fn) { builtinRunner = fn; }

function appLabel(toolkit) {
  return toolkit === BUILTIN ? 'Wingman' : composio.appName(toolkit);
}

function clip(v, n) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function builtinPreview(slug, a = {}, userId = null) {
  switch (slug) {
    case 'send_email':
    case 'send_business_email':
      return `Send email to ${a.to || '?'} — "${clip(a.subject || '(no subject)', 80)}": ${clip(a.body, 300)}`;
    case 'reply_to_email':
    case 'reply_business_email': {
      // Name the person, not a message id ("Reply to Ali Raza: …").
      let who = '';
      try {
        const gid = slug === 'reply_business_email' ? `webmail:${a.uid}` : String(a.email_id || a.id || '');
        const r = userId ? require('../db').db.prepare('SELECT sender FROM email_items WHERE user_id = ? AND gmail_id = ? LIMIT 1').get(userId, gid) : null;
        if (r && r.sender) who = String(r.sender).replace(/\s*<.*>/, '').replace(/"/g, '').trim();
      } catch (_) { /* fall back to the id */ }
      return `Reply to ${who || `email ${a.email_id || a.uid || a.id || ''}`}: ${clip(a.body, 300)}`.replace(/ +:/, ':');
    }
    case 'forward_email':
      return `Forward email ${a.email_id || ''} to ${a.to || '?'}${a.note ? ` with note: ${clip(a.note, 200)}` : ''}`;
    case 'delete_event':
      return `Cancel calendar event ${a.event_id || a.id || ''} (guests are notified)`;
    case 'delete_drive_file':
      return `Delete Drive file ${a.file_id || a.id || ''} (moves to Trash)`;
    case 'book_ride':
      return `Book ${a.product_name || 'an Uber'} from ${a.from || 'your current location'} to ${a.to || '?'}${a.fare ? ` — ${a.fare}` : ''} (charged to Wingman's Uber account)`;
    case 'cancel_ride':
      return 'Cancel your Uber ride (Uber may charge a cancellation fee if the driver is already on the way)';
    case 'create_event':
      return `Create calendar event "${clip(a.title || '(untitled)', 80)}" at ${a.start_time || '?'} and email the invite to ${(a.attendees || []).join(', ')}`;
    case 'update_event':
      return `Update calendar event ${a.event_id || ''} and email the change to ${(a.attendees || []).join(', ')}`;
    case 'create_automation':
      return `New automation (${[a.kind, a.weekday, a.date, a.time].filter(Boolean).join(' ') || 'scheduled'}): "${clip(a.instruction, 300)}"`;
    case 'share_drive_file':
      return `Share Drive file ${a.file_id || ''} with ${a.email || 'anyone who has the link'} (${a.can_edit ? 'can edit' : 'view only'})`;
    default:
      return `${slug.replace(/_/g, ' ')} ${clip(JSON.stringify(a), 300)}`;
  }
}

function preview(toolkit, slug, args, userId = null) {
  if (toolkit === BUILTIN) return builtinPreview(slug, args, userId);
  let a = '';
  try { a = JSON.stringify(args || {}); } catch (_) { a = '{}'; }
  if (a.length > 400) a = a.slice(0, 400) + '…';
  if (slug === RULE) return `New rule — do this without asking from now on: ${(args && args.about) || ''} (${composio.appName(toolkit)})`;
  const what = slug === DISCONNECT ? 'Disconnect' : slug.replace(/_/g, ' ').toLowerCase();
  return `${composio.appName(toolkit)} — ${what} ${a === '{}' ? '' : a}`.trim();
}

async function propose(user, { toolkit, slug, version, args }, ctx = {}) {
  // Same action already waiting? Don't pile up duplicates (the chat history is
  // text-only, so the model often re-calls the tool on the user's "yes"
  // instead of approve_integration_action). If the user has replied since it
  // was shown to them, and this is a live chat turn, the re-call is the go-ahead.
  actions.expireOld(config.composio.approvalTtlMinutes);
  const same = actions.findSamePending(user.id, slug, args);
  if (same) {
    if (!ctx.automated && actions.userHasRepliedSince(user.id, same)) return approve(user, same.id, ctx);
    return {
      approval_required: true,
      action_id: same.id,
      instruction: 'This exact action is already waiting for the user\'s yes. Show it once and wait for their reply.',
    };
  }
  const summary = preview(toolkit, slug, args, user.id);
  const row = actions.create({ userId: user.id, toolkit, toolSlug: slug, toolVersion: version, args, summary });
  return {
    approval_required: true,
    action_id: row.id,
    app: appLabel(toolkit),
    action: slug,
    details: args,
    instruction:
      'Nothing has been done yet. Show the user EXACTLY what will happen (recipient, content, ' +
      'amount, which account) in plain words and ask for a yes/no. Only after they reply yes, ' +
      'call approve_integration_action with this action_id.',
  };
}

async function runApproved(user, row) {
  if (row.toolkit === BUILTIN) {
    if (!builtinRunner) return { ok: false, error: 'BUILTIN_RUNNER_MISSING' };
    try {
      const r = await builtinRunner(user, row.tool_slug, row.arguments || {});
      return r && r.error ? { ok: false, error: r.detail ? `${r.error}: ${r.detail}` : r.error } : { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (row.tool_slug === RULE) {
    const a = row.arguments || {};
    const r = require('../db/userRules').add(user.id, {
      kind: 'auto_approve', text: a.about, toolkit: row.toolkit, toolSlug: a.tool,
    });
    return r.added || r.reason === 'duplicate'
      ? { ok: true, data: { rule_saved: true, note: 'From now on this action runs without asking. Tell the user in one line, and that they can take it back any time.' } }
      : { ok: false, error: r.reason || 'could not save the rule' };
  }
  if (row.tool_slug === DISCONNECT) {
    try {
      const r = await composio.disconnect(user, row.toolkit);
      return r.error ? { ok: false, error: r.error } : { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return composio.execute(user, row.tool_slug, row.arguments, row.tool_version);
}

async function approve(user, actionId, ctx = {}) {
  if (ctx.automated) return { error: 'NEEDS_USER_CONFIRMATION', detail: 'Automated runs cannot approve actions.' };
  actions.expireOld(config.composio.approvalTtlMinutes);
  const row = actions.get(user.id, String(actionId || ''));
  if (!row) return { error: 'ACTION_NOT_FOUND' };
  if (row.status !== 'pending') return { error: `ACTION_${String(row.status).toUpperCase()}`, detail: `This action is already ${row.status}.` };
  if (!actions.userHasRepliedSince(user.id, row)) {
    return {
      error: 'NEEDS_USER_CONFIRMATION',
      detail: 'The user has not replied yet. Show them the action and wait for their yes in their next message.',
    };
  }
  if (!actions.claim(user.id, row.id)) return { error: 'ACTION_ALREADY_HANDLED' };

  // Duplicates of this same action (e.g. from repeated proposals) must never run twice.
  actions.cancelDuplicates(user.id, row);
  const res = await runApproved(user, row);
  actions.finish(user.id, row.id, { ok: res.ok, result: res.ok ? res.data : res.error });
  if (res.ok) {
    agentActions.log(user.id, { kind: `integration.${row.tool_slug}`, summary: row.summary, source: 'chat' });
    // Earned autonomy: after enough yeses for the same kind, offer to stop asking.
    let offer = null;
    try { offer = require('../services/autonomy').afterApproval(user, { ...row, result: res.data }); } catch (_) { /* optional */ }
    return { done: true, app: appLabel(row.toolkit), result: res.data, ...(offer ? { autonomy_offer: offer } : {}) };
  }
  return { error: 'ACTION_FAILED', app: appLabel(row.toolkit), detail: res.error };
}

async function listIntegrations(user) {
  const available = composio.availableApps();
  let connected = [];
  try {
    connected = (await composio.listConnections(user, { fresh: true })).map((a) => a.toolkit);
  } catch (e) {
    return { error: 'INTEGRATIONS_UNAVAILABLE', detail: e.message };
  }
  actions.expireOld(config.composio.approvalTtlMinutes);
  return {
    apps: available.map((slug) => ({ app: slug, name: composio.appName(slug), connected: connected.includes(slug) })),
    pending_actions: actions.listPending(user.id),
  };
}

async function executeIntegrationTool(user, toolUse, ctx = {}) {
  const { name, input = {} } = toolUse;
  try {
    if (!config.composio.enabled && !APPROVAL_TOOL_NAMES.has(name)) return { error: 'INTEGRATIONS_NOT_CONFIGURED' };

    if (managementToolNames.has(name)) {
      switch (name) {
        case 'list_integrations':
          return listIntegrations(user);
        case 'connect_integration':
          return composio.connectLink(user, input.app);
        case 'find_app_tools':
          return composio.findTools(user, input.app, input.what, input.tools);
        case 'disconnect_integration': {
          const slug = String(input.app || '').toLowerCase();
          const apps = await composio.listConnections(user, { fresh: true });
          if (!apps.some((a) => a.toolkit === slug)) return { error: 'NOT_CONNECTED', app: slug };
          return propose(user, { toolkit: slug, slug: DISCONNECT, version: null, args: {} }, ctx);
        }
        case 'approve_integration_action':
          return approve(user, input.action_id, ctx);
        case 'cancel_integration_action':
          return actions.cancel(user.id, String(input.action_id || ''))
            ? { cancelled: true }
            : { error: 'NOTHING_TO_CANCEL' };
        default:
          return { error: 'UNKNOWN_TOOL' };
      }
    }

    // An app tool (Composio slug). Only tools we offered this user are allowed.
    const meta = composio.toolMeta(name);
    if (!meta) return { error: 'UNKNOWN_TOOL', detail: `${name} is not an available integration tool.` };
    const connected = await composio.listConnections(user);
    if (!connected.some((a) => a.toolkit === meta.toolkit)) {
      return { error: 'APP_NOT_CONNECTED', app: meta.toolkit, detail: 'Offer the connect link (connect_integration).' };
    }

    if (meta.readOnly || PREP_NO_APPROVAL.has(name)) {
      const res = await composio.execute(user, name, input, meta.version);
      return res.ok ? { app: composio.appName(meta.toolkit), result: res.data } : { error: 'ACTION_FAILED', detail: res.error };
    }
    // The user has said "don't ask me for this one" — run it, record it, and say so.
    // Chat turns only: an automated run (where the text could come from an email
    // or a web page) never gets to skip the yes.
    if (!ctx.automated && canEverAutoApprove(meta.toolkit, name, meta) &&
        require('../db/userRules').hasAutoApprove(user.id, name)) {
      const res = await composio.execute(user, name, input, meta.version);
      if (!res.ok) return { error: 'ACTION_FAILED', app: composio.appName(meta.toolkit), detail: res.error };
      agentActions.log(user.id, { kind: `integration.${name}`, summary: `(standing rule) ${preview(meta.toolkit, name, input)}`, source: 'auto' });
      return {
        done: true, auto_approved: true, app: composio.appName(meta.toolkit), result: res.data,
        note: 'Ran without asking because of the user\'s standing rule. Tell them briefly what you did.',
      };
    }
    return propose(user, { toolkit: meta.toolkit, slug: name, version: meta.version, args: input }, ctx);
  } catch (e) {
    console.warn(`[integrations] ${name} failed:`, e.message);
    return { error: 'INTEGRATION_ERROR', detail: e.message };
  }
}

/**
 * A built-in critical tool (send_email, delete_event, …) was called. Park it
 * for the user's yes exactly like an app tool — always. (It used to run
 * straight away whenever Composio wasn't configured, which silently removed
 * the gate on deployments without a Composio key.) The built-in runner is
 * conversation.js's; propose()/approve() don't need Composio.
 */
async function gateBuiltin(user, name, input, ctx = {}, runNow) {
  // The user earned-autonomy'd this exact kind ("replies to Ali") — run it now.
  // Live chat only: an automated run never skips the yes.
  if (!ctx.automated && !ALWAYS_CONFIRM.has(name)) {
    let granted = false;
    try { granted = require('../services/autonomy').isGranted(user.id, BUILTIN, name, input || {}); } catch (_) { /* no */ }
    if (granted) {
      const out = await runNow();
      if (out && !out.error) {
        const row = actions.create({ userId: user.id, toolkit: BUILTIN, toolSlug: name, args: input || {}, summary: `(without asking) ${builtinPreview(name, input || {}, user.id)}` });
        actions.claim(user.id, row.id);
        actions.finish(user.id, row.id, { ok: true, result: out });
        agentActions.log(user.id, { kind: `integration.${name}`, summary: row.summary, source: 'auto' });
        return { ...out, auto_approved: true, note: 'Done without asking because the user allowed this kind of action. Tell them briefly what you did.' };
      }
      return out;
    }
  }
  return propose(user, { toolkit: BUILTIN, slug: name, version: null, args: input || {} }, ctx);
}

/**
 * "Don't ask me for this" → park a rule for the user's yes. The rule only ever
 * covers one exact tool of one connected app, and never a risky one.
 */
async function proposeAutoApproveRule(user, { app, tool, about }, ctx = {}) {
  if (!config.composio.enabled) return { error: 'INTEGRATIONS_NOT_CONFIGURED' };
  const slug = String(tool || '').trim().toUpperCase();
  const meta = composio.toolMeta(slug);
  if (!slug || !meta) {
    return { error: 'UNKNOWN_TOOL', detail: 'Give the exact CAPITALS tool name of a connected app (load it with find_app_tools first). Built-in actions like Gmail sending cannot have this rule.' };
  }
  if (app && String(app).toLowerCase() !== meta.toolkit) return { error: 'TOOL_APP_MISMATCH', detail: `${slug} belongs to ${meta.toolkit}.` };
  if (meta.readOnly) return { error: 'NOT_NEEDED', detail: 'That action only reads — it never asks anyway.' };
  if (!canEverAutoApprove(meta.toolkit, slug, meta)) {
    return { error: 'ALWAYS_NEEDS_YES', detail: 'Actions that delete things, move money or spend an ad budget always need the user\'s yes — tell them that plainly; no rule can change it.' };
  }
  const text = String(about || '').trim() || slug.replace(/_/g, ' ').toLowerCase();
  return propose(user, { toolkit: meta.toolkit, slug: RULE, version: null, args: { tool: slug, about: text } }, ctx);
}

/**
 * Text block for the system prompt listing this user's waiting actions WITH
 * their action_ids — chat history is text-only, so without this the model
 * forgets the id by the time the user says yes.
 */
function pendingActionsBlock(user) {
  try {
    if (!user) return '';
    actions.expireOld(config.composio.approvalTtlMinutes);
    const seen = new Set();
    const rows = actions.listPending(user.id).filter((r) => {
      const k = `${r.tool_slug}|${r.summary}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 5);
    if (!rows.length) return '';
    return '\n\n--- ACTIONS WAITING FOR THE USER\'S YES ---\n' +
      rows.map((r) => `- action_id ${r.id}: ${r.summary}`).join('\n') +
      '\nIf the user\'s latest message agrees to one of these (yes / haan / kar do / ok / go ahead, in any wording), call approve_integration_action with its action_id RIGHT NOW — do not ask again and do not re-create it. If they decline, cancel_integration_action.';
  } catch (_) {
    return '';
  }
}

module.exports = {
  executeIntegrationTool, pendingActionsBlock, proposeAutoApproveRule,
  gateBuiltin, setBuiltinRunner, BUILTIN_GATED, canEverAutoApprove, builtinNeedsYes,
};
