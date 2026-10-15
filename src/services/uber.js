'use strict';

/**
 * Uber Guest Rides API client (Uber for Business).
 *
 * Wingman books a ride FOR the user ("guest") on the business account:
 *   estimates(pickup, dropoff)  → products with fare_id + pickup ETA
 *   createTrip({...})           → request_id
 *   getTrip(request_id)         → status, driver, vehicle, ETA
 *   cancelTrip(request_id)
 *
 * Auth is OAuth client-credentials with the `guests.trips` scope; the token is
 * cached until shortly before it expires. Responses are normalised by
 * `normaliseTrip` / `normaliseEstimates` so the rest of the code never depends
 * on Uber's exact field names (they differ a little between API versions).
 */

const crypto = require('crypto');
const config = require('../config');

let token = null; // { value, expiresAt }

function notConfigured() {
  const e = new Error('UBER_NOT_CONFIGURED');
  e.code = 'UBER_NOT_CONFIGURED';
  return e;
}

async function accessToken() {
  if (!config.uber.enabled) throw notConfigured();
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const body = new URLSearchParams({
    client_id: config.uber.clientId,
    client_secret: config.uber.clientSecret,
    grant_type: 'client_credentials',
    scope: config.uber.scope,
  });
  const res = await fetch(config.uber.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const e = new Error(`UBER_AUTH_FAILED: ${data.error_description || data.error || res.status}`);
    e.code = 'UBER_AUTH_FAILED';
    throw e;
  }
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

async function api(method, path, body) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'en_US',
  };
  if (config.uber.orgId) headers['x-uber-organizationuuid'] = config.uber.orgId;
  const res = await fetch(`${config.uber.baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) token = null; // force a fresh token next time
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.message || data.title || data.code || (data.errors && data.errors[0] && (data.errors[0].title || data.errors[0].code)) || `HTTP ${res.status}`;
    const e = new Error(`UBER_${res.status}: ${msg}`);
    e.status = res.status;
    e.code = data.code || `UBER_${res.status}`;
    e.data = data;
    throw e;
  }
  return data;
}

const pt = (p) => {
  const out = { latitude: Number(p.lat), longitude: Number(p.lng) };
  if (p.address) out.address = String(p.address).slice(0, 200);
  return out;
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Turn whatever shape the estimates call returns into a flat option list. */
function normaliseEstimates(data) {
  const list = data.product_estimates || data.estimates || data.products || [];
  return list.map((e) => {
    const product = e.product || e;
    const info = e.estimate_info || e;
    const fare = info.fare || e.fare || {};
    const value = num(fare.value != null ? fare.value : (fare.fare_breakdown && fare.fare_breakdown.total) || info.estimate_value);
    let pickupMin = num(info.pickup_estimate != null ? info.pickup_estimate : e.pickup_estimate);
    if (pickupMin == null && e.eta_seconds != null) pickupMin = Math.round(Number(e.eta_seconds) / 60);
    return {
      product_id: product.product_id || e.product_id,
      name: product.display_name || product.name || e.display_name || 'Uber',
      description: product.description || product.short_description || null,
      capacity: num(product.capacity),
      fare_id: fare.fare_id || info.fare_id || e.fare_id || null,
      fare: fare.display || info.display || (value != null ? `${fare.currency_code || ''} ${value}`.trim() : null),
      fare_value: value,
      currency: fare.currency_code || info.currency_code || null,
      fare_expires_at: num(fare.expires_at),
      pickup_eta_min: pickupMin,
      trip_minutes: num(info.trip && info.trip.duration_estimate) != null ? Math.round(info.trip.duration_estimate / 60) : null,
      no_cars: !!(e.no_cars_available || info.no_cars_available),
    };
  }).filter((o) => o.product_id);
}

/** Flatten a trip into what we store / tell the user. */
function normaliseTrip(t) {
  const d = t.driver || {};
  const v = t.vehicle || {};
  const pick = t.pickup || {};
  const loc = t.location || (d.location) || {};
  let eta = num(pick.eta != null ? pick.eta : t.eta);
  if (eta == null && t.pickup_eta_seconds != null) eta = Math.round(Number(t.pickup_eta_seconds) / 60);
  return {
    request_id: t.request_id || t.trip_id || t.id,
    status: String(t.status || t.trip_status || 'processing').toLowerCase(),
    driver_name: d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || null,
    driver_phone: d.phone_number || d.sms_number || null,
    driver_rating: num(d.rating),
    vehicle: [v.vehicle_color_name || v.color, v.make, v.model].filter(Boolean).join(' ') || null,
    plate: v.license_plate || v.plate || null,
    eta_min: eta,
    driver_lat: num(loc.latitude),
    driver_lng: num(loc.longitude),
    fare: (t.fare && (t.fare.display || t.fare.value)) || (t.receipt && t.receipt.total_charged) || null,
    product_name: (t.product && t.product.display_name) || t.product_name || null,
    share_url: t.trip_tracking_url || t.share_url || t.tracking_url || null,
  };
}

async function estimates(pickup, dropoff) {
  const data = await api('POST', '/v1/guests/trips/estimates', { pickup: pt(pickup), dropoff: pt(dropoff) });
  return normaliseEstimates(data);
}

/** E.164 phone for the guest ("+923001234567"). */
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d ? `+${d}` : '';
}

async function createTrip({ guest, pickup, dropoff, productId, fareId, noteForDriver }) {
  const body = {
    guest: {
      first_name: String(guest.firstName || 'Wingman').slice(0, 40),
      last_name: String(guest.lastName || 'Guest').slice(0, 40),
      phone_number: e164(guest.phone),
      locale: 'en_US',
    },
    pickup: pt(pickup),
    dropoff: pt(dropoff),
    product_id: productId,
    sender_display_name: 'Wingman',
  };
  if (fareId) body.fare_id = fareId;
  if (noteForDriver) body.note_for_driver = String(noteForDriver).slice(0, 200);
  const data = await api('POST', '/v1/guests/trips', body);
  return normaliseTrip(data);
}

async function getTrip(requestId) {
  return normaliseTrip(await api('GET', `/v1/guests/trips/${encodeURIComponent(requestId)}`));
}

async function cancelTrip(requestId) {
  await api('DELETE', `/v1/guests/trips/${encodeURIComponent(requestId)}`);
  return true;
}

/** Uber signs webhook bodies with HMAC-SHA256 of the client secret. */
function verifyWebhook(rawBody, signature) {
  if (!config.uber.clientSecret || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', config.uber.clientSecret).update(rawBody).digest('hex');
  const got = String(signature).replace(/^sha256=/, '').trim();
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const TERMINAL = new Set(['completed', 'rider_canceled', 'driver_canceled', 'no_drivers_available', 'canceled', 'cancelled', 'failed', 'expired']);

function _resetToken() { token = null; }

module.exports = {
  estimates, createTrip, getTrip, cancelTrip, verifyWebhook,
  normaliseTrip, normaliseEstimates, e164, TERMINAL, _resetToken,
};
