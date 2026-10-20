'use strict';

const { db, uuid } = require('./index');

/**
 * Upsert an analyzed email into email_items, keyed by (user_id, gmail_id).
 * Returns the row id.
 */
function upsert(userId, item) {
  const existing = db
    .prepare('SELECT id FROM email_items WHERE user_id = ? AND gmail_id = ?')
    .get(userId, item.gmailId);

  const row = {
    user_id: userId,
    gmail_id: item.gmailId,
    account_id: item.accountId || null,
    account_email: item.accountEmail || null,
    subject: item.subject || null,
    sender: item.sender || null,
    category: item.category || 'fyi',
    summary: item.summary || null,
    action_needed: item.actionNeeded ? 1 : 0,
    replied: item.replied ? 1 : 0,
    draft_reply: item.draftReply || null,
    detected_type: item.detectedType || 'general',
    extracted_data: JSON.stringify(item.extractedData || {}),
    received_at: item.receivedAt || null,
  };

  if (existing) {
    db.prepare(`
      UPDATE email_items SET
        account_id=COALESCE(@account_id, account_id), account_email=COALESCE(@account_email, account_email),
        subject=@subject, sender=@sender, category=@category, summary=@summary,
        action_needed=@action_needed, replied=MAX(COALESCE(replied, 0), @replied), draft_reply=@draft_reply,
        detected_type=@detected_type, extracted_data=@extracted_data,
        received_at=COALESCE(@received_at, received_at)
      WHERE id=@id
    `).run({ ...row, id: existing.id });
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO email_items
      (id, user_id, gmail_id, account_id, account_email, subject, sender, category, summary,
       action_needed, replied, draft_reply, detected_type, extracted_data, received_at)
    VALUES
      (@id, @user_id, @gmail_id, @account_id, @account_email, @subject, @sender, @category, @summary,
       @action_needed, @replied, @draft_reply, @detected_type, @extracted_data, @received_at)
  `).run({ ...row, id });
  return id;
}

/** The user answered this email (from any route) — keep it marked even if re-scanned. */
function markReplied(userId, gmailId) {
  return db.prepare("UPDATE email_items SET replied = 1, replied_at = datetime('now'), prepared_reply = NULL WHERE user_id = ? AND gmail_id = ?")
    .run(userId, String(gmailId)).changes;
}

/** A reply Wingman drafted in the user's voice, waiting for their yes. */
function setPrepared(userId, id, { reply, note = null }) {
  db.prepare("UPDATE email_items SET prepared_reply = ?, prepared_note = ?, prepared_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(reply, note, id, userId);
}

function listPrepared(userId, limit = 10) {
  return db.prepare(`SELECT * FROM email_items WHERE user_id = ? AND prepared_reply IS NOT NULL AND replied = 0
    ORDER BY COALESCE(received_at, created_at) DESC LIMIT ?`).all(userId, limit);
}

/** One email item by its row id, scoped to the user. */
function getById(userId, id) {
  return db.prepare('SELECT * FROM email_items WHERE id = ? AND user_id = ?').get(id, userId);
}

/** Whether we've already stored a given gmail id for this user. */
function existsByGmailId(userId, gmailId) {
  return !!db
    .prepare('SELECT 1 FROM email_items WHERE user_id = ? AND gmail_id = ?')
    .get(userId, gmailId);
}

/** All email items for a user, newest first. */
function listForUser(userId, limit = 100) {
  return db
    .prepare('SELECT * FROM email_items WHERE user_id = ? ORDER BY COALESCE(received_at, created_at) DESC LIMIT ?')
    .all(userId, limit);
}

/**
 * Items grouped by category for the digest. Returns
 * { urgent: [...], needs_reply: [...], fyi: [...], spam: [...] }.
 */
function groupedByCategory(userId, limit = 100) {
  const rows = listForUser(userId, limit);
  const groups = { urgent: [], needs_reply: [], fyi: [], spam: [] };
  for (const r of rows) {
    const cat = groups[r.category] ? r.category : 'fyi';
    groups[cat].push(r);
  }
  return groups;
}

/**
 * Count urgent and needs_reply items created since a given ISO timestamp.
 * Returns { urgent, needsReply }.
 */
function countsSince(userId, sinceISO) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN category='urgent' THEN 1 ELSE 0 END) urgent,
      SUM(CASE WHEN category='needs_reply' THEN 1 ELSE 0 END) needsReply
    FROM email_items
    WHERE user_id = ? AND created_at >= ?
  `).get(userId, sinceISO);
  return { urgent: row.urgent || 0, needsReply: row.needsReply || 0 };
}

/** Count emails the user has replied to (replied=1). */
function countReplied(userId) {
  return db.prepare('SELECT COUNT(*) c FROM email_items WHERE user_id = ? AND replied = 1').get(userId).c;
}

/** Count unreplied action-needed emails still pending. */
function countPending(userId) {
  return db.prepare(
    'SELECT COUNT(*) c FROM email_items WHERE user_id = ? AND replied = 0 AND action_needed = 1'
  ).get(userId).c;
}

/**
 * Find email items whose subject/summary/extracted_data mention a keyword
 * (case-insensitive). Used for hotel-matching and expense compilation.
 */
function searchByKeyword(userId, keyword, { types } = {}) {
  const like = `%${(keyword || '').toLowerCase()}%`;
  let rows = db.prepare(
    `SELECT * FROM email_items WHERE user_id = ?
       AND (LOWER(IFNULL(subject,'')) LIKE ? OR LOWER(IFNULL(summary,'')) LIKE ?
            OR LOWER(IFNULL(extracted_data,'')) LIKE ? OR LOWER(IFNULL(sender,'')) LIKE ?)
     ORDER BY created_at DESC`
  ).all(userId, like, like, like, like);
  if (types && types.length) rows = rows.filter((r) => types.includes(r.detected_type));
  return rows;
}

/** All items of a given detected_type. */
function listByType(userId, type) {
  return db.prepare('SELECT * FROM email_items WHERE user_id = ? AND detected_type = ? ORDER BY created_at DESC')
    .all(userId, type);
}

function listIdsByAccount(userId, accountId) {
  return db.prepare(`
    SELECT id FROM email_items
    WHERE user_id = ? AND account_id = ?
  `).all(userId, accountId).map((r) => r.id);
}

function deleteByAccount(userId, accountId) {
  return db.prepare('DELETE FROM email_items WHERE user_id = ? AND account_id = ?').run(userId, accountId).changes;
}

function deleteAllForUser(userId) {
  return db.prepare('DELETE FROM email_items WHERE user_id = ?').run(userId).changes;
}

module.exports = {
  upsert, getById, existsByGmailId, listForUser, groupedByCategory,
  countsSince, countReplied, countPending, searchByKeyword, listByType,
  listIdsByAccount, deleteByAccount, deleteAllForUser, markReplied, setPrepared, listPrepared,
};
