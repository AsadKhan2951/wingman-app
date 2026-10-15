'use strict';

/**
 * Ride tracker — keeps the user posted about a ride Wingman booked.
 *
 * Every few seconds (UBER_POLL_SECONDS, default 20) it polls Uber for each
 * ACTIVE ride; an Uber webhook (POST /webhooks/uber) triggers the same check
 * immediately. Each notification goes out once (rides.notified):
 *   assigned — driver accepted: name, car, plate, minutes away
 *   near     — driver ≤ 2 min away
 *   arrived  — "your cab is here"
 *   started  — (silent; just recorded)
 *   done     — dropped off (fare) / cancelled / no drivers → offer to rebook
 */

const config = require('../config');
const uber = require('./uber');
const rides = require('../db/rides');
const users = require('../db/users');

const wa = () => require('../whatsapp/client');

let timer = null;
let running = false;

function driverLine(r) {
  const bits = [];
  if (r.vehicle) bits.push(r.vehicle);
  if (r.plate) bits.push(`plate *${r.plate}*`);
  return bits.join(', ');
}

/** What (if anything) to tell the user now, given the latest ride row. */
function messagesFor(r) {
  const out = [];
  const s = r.status;
  const sent = rides.notifiedSet(r);

  if (['accepted', 'arriving', 'in_progress', 'driver_assigned', 'en_route'].includes(s) && r.driver_name && !sent.has('assigned')) {
    out.push({
      key: 'assigned',
      text: `🚕 Your Uber is booked — *${r.driver_name}* is coming${r.eta_min != null ? ` (${r.eta_min} min away)` : ''}.\n${driverLine(r)}${r.driver_phone ? `\nDriver: ${r.driver_phone}` : ''}${r.share_url ? `\nTrack: ${r.share_url}` : ''}`,
    });
  }
  if (['accepted', 'en_route', 'driver_assigned'].includes(s) && r.eta_min != null && r.eta_min <= 2 && !sent.has('near') && !sent.has('arrived')) {
    out.push({ key: 'near', text: `⏱️ Your driver is about ${Math.max(1, r.eta_min)} min away — head down to the pickup point.` });
  }
  if (s === 'arriving' && !sent.has('arrived')) {
    out.push({
      key: 'arrived',
      text: `✅ Your cab is here${r.driver_name ? `, ${r.driver_name.split(' ')[0]} is waiting` : ''}.${r.plate ? ` Look for *${r.plate}*` : ''}${r.vehicle ? ` (${r.vehicle})` : ''}.`,
    });
  }
  if (s === 'in_progress' && !sent.has('started')) out.push({ key: 'started', text: null });
  if (s === 'completed' && !sent.has('done')) {
    out.push({ key: 'done', text: `🏁 You've arrived at ${r.dropoff_label || 'your destination'}.${r.fare ? ` Fare: ${r.fare}.` : ''}` });
  }
  if (s === 'driver_canceled' && !sent.has('done')) {
    out.push({ key: 'done', text: '⚠️ Your Uber driver cancelled. Want me to book another one?' });
  }
  if (s === 'no_drivers_available' && !sent.has('done')) {
    out.push({ key: 'done', text: '⚠️ Uber couldn\'t find a driver right now. Want me to try again, or pick a different ride type?' });
  }
  return out;
}

async function notify(ride, msgs) {
  const user = users.getById(ride.user_id);
  if (!user || !user.phone) return;
  for (const m of msgs) {
    if (!rides.markNotified(ride.id, m.key)) continue; // someone else already sent it
    if (!m.text) continue;
    try {
      // Time-critical: goes out even near the 24h edge (they just asked for the ride).
      await wa().sendMessage(user.phone, m.text, { skipDedupe: true, urgent: true });
    } catch (err) {
      console.warn('[rides] notify failed:', err.message);
    }
  }
}

/** Refresh one ride from Uber and send whatever is due. */
async function checkRide(ride) {
  let trip;
  try {
    trip = await uber.getTrip(ride.request_id);
  } catch (err) {
    console.warn(`[rides] status ${ride.request_id} failed:`, err.message);
    return null;
  }
  const updated = rides.updateFromTrip(ride.id, trip);
  // A ride can jump straight from "processing" to "arriving" between polls —
  // the driver details still go out first, then "your cab is here".
  await notify(updated, messagesFor(updated));
  return updated;
}

async function runOnce() {
  if (!config.uber.enabled || running) return 0;
  running = true;
  try {
    const list = rides.listActive();
    for (const r of list) await checkRide(r);
    return list.length;
  } finally {
    running = false;
  }
}

/** Webhook nudge: re-check one ride right away. */
async function onWebhook(body) {
  const rid = (body && (body.meta && (body.meta.resource_id || body.meta.request_id))) || (body && (body.resource_id || body.request_id));
  const ride = rides.getByRequestId(rid);
  if (!ride) return false;
  await checkRide(ride);
  return true;
}

function start() {
  if (timer || !config.uber.enabled) return;
  const ms = Math.max(5, config.uber.pollSeconds) * 1000;
  timer = setInterval(() => { runOnce().catch((e) => console.warn('[rides] tick failed:', e.message)); }, ms);
  if (timer.unref) timer.unref();
  console.log(`[rides] tracker on (every ${ms / 1000}s)`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, runOnce, checkRide, onWebhook, messagesFor };
