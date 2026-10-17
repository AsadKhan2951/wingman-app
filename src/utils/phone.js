'use strict';

const config = require('../config');

/**
 * Canonical phone key for MATCHING (not for sending).
 *
 * A full international number (11–15 digits, no leading 0) is its own key, so
 * 923001234567 and 443001234567 are DIFFERENT people. (Matching used to be on
 * the last 10 digits only, which let a number in another country that shares
 * those digits sign in as — and receive — someone else's Wingman.)
 *
 * Local / legacy forms without a country code (03001234567, 3001234567) are
 * read as numbers in `phone.legacyCountryCode`, so old 10-digit rows still
 * unify with the full number WhatsApp sends.
 */
function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length >= 11 && d.length <= 15 && !d.startsWith('0')) return d;
  const local = d.replace(/^0+/, '');
  const cc = config.phone.legacyCountryCode;
  if (local.length === 10 && cc) return `${cc}${local}`;
  return local;
}

module.exports = { phoneKey };
