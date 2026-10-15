'use strict';

/** Rides Wingman booked for users (see schema.sql `rides`). Sync, like all db/. */

const { db, uuid } = require('./index');

const ACTIVE = ['processing', 'accepted', 'arriving', 'in_progress', 'scheduled', 'driver_assigned', 'en_route'];

function create(row) {
  const id = uuid();
  db.prepare(`
    INSERT INTO rides (id, user_id, provider, request_id, status, product_name, fare,
      pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng)
    VALUES (@id, @userId, @provider, @requestId, @status, @productName, @fare,
      @pickupLabel, @pickupLat, @pickupLng, @dropoffLabel, @dropoffLat, @dropoffLng)
  `).run({
    id,
    userId: row.userId,
    provider: row.provider || 'uber',
    requestId: row.requestId || null,
    status: row.status || 'processing',
    productName: row.productName || null,
    fare: row.fare || null,
    pickupLabel: row.pickupLabel || null,
    pickupLat: row.pickupLat ?? null,
    pickupLng: row.pickupLng ?? null,
    dropoffLabel: row.dropoffLabel || null,
    dropoffLat: row.dropoffLat ?? null,
    dropoffLng: row.dropoffLng ?? null,
  });
  return getById(id);
}

const getById = (id) => db.prepare('SELECT * FROM rides WHERE id = ?').get(id) || null;
const getByRequestId = (rid) => (rid ? db.prepare('SELECT * FROM rides WHERE request_id = ?').get(String(rid)) || null : null);

/** Only the fields the tracker learns from Uber. */
function updateFromTrip(id, t) {
  const cols = {
    status: t.status, driver_name: t.driver_name, driver_phone: t.driver_phone,
    vehicle: t.vehicle, plate: t.plate, eta_min: t.eta_min, share_url: t.share_url,
  };
  if (t.fare) cols.fare = String(t.fare);
  const set = Object.keys(cols).filter((k) => cols[k] !== undefined && cols[k] !== null);
  if (!set.length) return getById(id);
  const sql = `UPDATE rides SET ${set.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now')${
    ACTIVE.includes(t.status) ? '' : ", finished_at = COALESCE(finished_at, datetime('now'))"} WHERE id = @id`;
  db.prepare(sql).run({ ...Object.fromEntries(set.map((k) => [k, cols[k]])), id });
  return getById(id);
}

function setStatus(id, status) {
  db.prepare(`UPDATE rides SET status = ?, updated_at = datetime('now')${
    ACTIVE.includes(status) ? '' : ", finished_at = COALESCE(finished_at, datetime('now'))"} WHERE id = ?`).run(status, id);
  return getById(id);
}

const notifiedSet = (r) => new Set(String((r && r.notified) || '').split(',').filter(Boolean));

/** Mark a notification as sent; false if it was already sent (no double ping). */
function markNotified(id, key) {
  const r = getById(id);
  const s = notifiedSet(r);
  if (s.has(key)) return false;
  s.add(key);
  db.prepare('UPDATE rides SET notified = ? WHERE id = ?').run([...s].join(','), id);
  return true;
}

function listActive() {
  return db.prepare(`SELECT * FROM rides WHERE status IN (${ACTIVE.map(() => '?').join(',')}) AND request_id IS NOT NULL
    AND created_at > datetime('now', '-6 hours') ORDER BY created_at`).all(...ACTIVE);
}

function latestForUser(userId) {
  return db.prepare('SELECT * FROM rides WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId) || null;
}

function activeForUser(userId) {
  return db.prepare(`SELECT * FROM rides WHERE user_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId, ...ACTIVE) || null;
}

module.exports = {
  ACTIVE, create, getById, getByRequestId, updateFromTrip, setStatus,
  markNotified, notifiedSet, listActive, latestForUser, activeForUser,
};
