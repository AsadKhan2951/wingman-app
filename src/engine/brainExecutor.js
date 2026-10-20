'use strict';

/**
 * Runs the judgement-layer tools (see brainTools.js). Never throws.
 *
 * auto_approve rules are the only ones that LOOSEN a safety check, so they are
 * not saved here: they are parked through the integration approval gate and
 * only become real after the user's own yes (see integrationExecutor).
 */

const rules = require('../db/userRules');

const KIND_LABEL = {
  auto_approve: 'Do without asking',
  always_ask: 'Always ask first',
  notify_mute: "Don't tell me about",
  notify_always: 'Always tell me about',
  behavior: 'Always',
};

async function executeBrainTool(user, toolUse, ctx = {}) {
  const { name, input = {} } = toolUse;
  try {
    if (!user) return { error: 'NO_USER' };

    if (name === 'set_rule') {
      const kind = String(input.kind || '');
      if (!rules.KINDS.has(kind)) return { error: 'BAD_KIND' };
      if (kind === 'auto_approve') {
        // Loosening a check must go through the user's explicit yes.
        return require('./integrationExecutor').proposeAutoApproveRule(user, {
          app: input.app, tool: input.tool, about: input.about,
        }, ctx);
      }
      const r = rules.add(user.id, { kind, text: input.about });
      if (r.reason === 'too_many') return { error: 'TOO_MANY_RULES', detail: 'Ask the user to remove an old rule first.' };
      return { saved: true, rule: `${KIND_LABEL[kind]}: ${String(input.about || '').trim()}`, note: 'Confirm it back to the user in one short line.' };
    }

    if (name === 'grant_autonomy') {
      if (ctx.automated) return { error: 'NEEDS_USER_CONFIRMATION' };
      return require('../services/autonomy').grant(user, String(input.offer_key || ''));
    }

    if (name === 'list_rules') {
      const rows = rules.listForUser(user.id);
      return rows.length
        ? { rules: rows.map((r) => ({ rule_id: r.id, rule: `${KIND_LABEL[r.kind] || r.kind}: ${r.text}` })) }
        : { rules: [], note: 'No standing rules yet.' };
    }

    if (name === 'remove_rule') {
      const n = rules.remove(user.id, { id: input.rule_id, about: input.about });
      return n ? { removed: n } : { error: 'NO_MATCHING_RULE' };
    }

    if (name === 'set_briefing_call') {
      const out = require('../services/briefingCall').setEnabled(user.id, !!input.on);
      return {
        ...out,
        note: out.briefing_call && !out.calls_available
          ? 'Saved. WhatsApp calls are not switched on for Wingman yet, so for now the briefing and wrap come with a voice note; calls start automatically once they are live.'
          : 'Saved.',
      };
    }
    if (name === 'restudy_app') {
      return require('../services/appStudy').restudy(user, input.app);
    }

    return { error: 'UNKNOWN_TOOL' };
  } catch (e) {
    console.warn(`[brain] ${name} failed:`, e.message);
    return { error: 'RULE_ERROR', detail: String(e.message || '').slice(0, 200) };
  }
}

/** System-prompt block listing this user's standing rules. */
function rulesBlock(user) {
  try {
    if (!user) return '';
    const rows = rules.listForUser(user.id);
    if (!rows.length) return '';
    const behavior = rows.filter((r) => r.kind === 'behavior');
    const other = rows.filter((r) => r.kind !== 'behavior');
    let out = '';
    if (behavior.length) {
      out += '\n\n--- THE USER\'S OWN RULES FOR YOU (their corrections — obey every one, in every reply) ---\n' +
        behavior.map((r) => `- ${r.text}`).join('\n') +
        '\nThese beat everything else in this prompt about tone, length, language, format and habits. Breaking one is the fastest way to lose their trust. Check your reply against them before sending.';
    }
    if (other.length) {
      out += '\n\n--- STANDING RULES THIS USER GAVE YOU ---\n' +
        other.map((r) => `- ${KIND_LABEL[r.kind] || r.kind}: ${r.text}`).join('\n') +
        '\nFollow these exactly. They override your defaults about when to ask or tell — but never the system\'s own approval gate.';
    }
    return out;
  } catch (_) {
    return '';
  }
}

/** Plain-text version of the notify rules, for the background email classifier. */
function notifyRulesText(userId) {
  try {
    const rows = rules.listForUser(userId).filter((r) => r.kind === 'notify_mute' || r.kind === 'notify_always');
    if (!rows.length) return '';
    return rows.map((r) => (r.kind === 'notify_mute' ? `Do NOT notify them about: ${r.text}` : `ALWAYS notify them about: ${r.text}`)).join('\n');
  } catch (_) {
    return '';
  }
}

module.exports = { executeBrainTool, rulesBlock, notifyRulesText, KIND_LABEL };
