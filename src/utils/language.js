'use strict';

/**
 * Which language to WRITE to a user in — decided from how they actually write,
 * never guessed from their country or timezone. A Karachi user who only ever
 * writes English gets English, everywhere (chat, goals, nudges, briefings).
 *
 *   userLanguage(user) → 'english' | 'roman_urdu' | 'urdu' | 'arabic'
 *   languageName(code) → "English" / "Roman Urdu (Urdu written in English letters, mixed with English)" …
 *   looksRomanUrdu(text) → true when a text is clearly Roman Urdu
 */

const { db } = require('../db');

// Common Roman Urdu words that almost never appear in English sentences.
// (Words that are also English — he, ha, main, ya, the — are left out on purpose.)
const RU_WORDS = new Set(('hai hain hy ka ki ke ko se mein mai aur nahi nai nhi kya kia kiya karo kar kardo krdo '
  + 'mujhe mujhy tum tumhe aap apka apki apne humein yeh ye woh wo kal aaj abhi bhi sab kuch kaise kese kahan kab '
  + 'kyun kyu bata batao chahiye chaye raha rahi rahe tha thi hoga hogi gaya gayi diya liya bhai yar yaar acha achha '
  + 'theek thik shukriya pata zaroor jaldi baad pehle nazdeeki dekho dehko lagta baje rakh hoon karna krna dena').split(/\s+/));

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z']+/g) || [];
}

/** True when a text is clearly Roman Urdu (enough Urdu function words). */
function looksRomanUrdu(text) {
  const w = words(text);
  if (w.length < 3) return false;
  const hits = w.filter((x) => RU_WORDS.has(x)).length;
  return hits >= 2 && hits / w.length >= 0.15;
}

const URDU_SCRIPT = /[؀-ۿ]/;

/** From the user's own recent messages. */
function fromMessages(userId, limit = 40) {
  let rows = [];
  try {
    rows = db.prepare("SELECT content FROM conversations WHERE user_id = ? AND role = 'user' AND content IS NOT NULL ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit);
  } catch (_) { return null; }
  const texts = rows.map((r) => String(r.content || '').trim()).filter((t) => t.length >= 3 && !/^\[/.test(t));
  if (texts.length < 3) return null;
  let script = 0;
  let roman = 0;
  for (const t of texts) {
    if (URDU_SCRIPT.test(t)) script += 1;
    else if (looksRomanUrdu(t)) roman += 1;
  }
  if (script / texts.length >= 0.3) return 'urdu';
  if (roman / texts.length >= 0.3) return 'roman_urdu';
  return 'english';
}

function userLanguage(user) {
  if (!user) return 'english';
  // 1) Learned from how they write (styleProfile).
  const sp = user.preferences && user.preferences.styleProfile && user.preferences.styleProfile.chat;
  const learned = String((sp && sp.language) || '').toLowerCase();
  if (learned) {
    if (/arabic/.test(learned)) return 'arabic';
    if (/urdu script|nastaliq/.test(learned)) return 'urdu';
    if (/roman urdu|urdu/.test(learned)) return 'roman_urdu';
    if (/english/.test(learned)) return 'english';
  }
  // 2) Their actual recent messages.
  const seen = fromMessages(user.id);
  if (seen) return seen;
  // 3) An explicit setting.
  const set = String(user.language || '').toLowerCase();
  if (set.startsWith('ar')) return 'arabic';
  if (set.startsWith('ur')) return 'roman_urdu';
  return 'english';
}

function languageName(code) {
  switch (code) {
    case 'roman_urdu': return 'Roman Urdu (Urdu written in English letters, naturally mixed with English words)';
    case 'urdu': return 'Urdu';
    case 'arabic': return 'Arabic';
    default: return 'English';
  }
}

module.exports = { userLanguage, languageName, looksRomanUrdu };
