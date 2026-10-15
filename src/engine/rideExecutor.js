'use strict';

/**
 * Executors for rideTools.js. book_ride and cancel_ride are in BUILTIN_GATED
 * (integrationExecutor.js): they only run after the user's yes.
 */
const config = require('../config');
const uber = require('../services/uber');
const maps = require('../services/maps');
const rides = require('../db/rides');
const agentActions = require('../db/agentActions');

// A "current" location older than this is not trusted for a pickup.
const LOCATION_MAX_AGE_MIN = 30;

const COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** "current" | "home" | "office" | "lat,lng" | address → { lat, lng, label } or { error }. */
async function resolvePlace(user, spec, { role }) {
  const s = String(spec || 'current').trim();
  const key = s.toLowerCase();

  if (['current', 'here', 'my location', 'current location', 'me'].includes(key)) {
    if (user.current_lat == null || user.current_lng == null) {
      return { error: 'NEED_LOCATION', detail: `I don't know where the user is. Ask them to share their current location on WhatsApp (📎 → Location → Send your current location) or to type the ${role} address.` };
    }
    const at = user.current_location_at ? Date.parse(user.current_location_at) : 0;
    const ageMin = at ? Math.round((Date.now() - at) / 60000) : null;
    if (!at || ageMin > LOCATION_MAX_AGE_MIN) {
      return {
        error: 'LOCATION_STALE',
        detail: `The last known location (${user.current_location_label || 'unknown'}) is ${ageMin == null ? 'of unknown age' : `${ageMin} minutes old`}. Ask them to share their current location on WhatsApp (📎 → Location → Send your current location), or to confirm the ${role} address.`,
      };
    }
    return { lat: Number(user.current_lat), lng: Number(user.current_lng), label: user.current_location_label || 'your current location' };
  }

  const m = s.match(COORD_RE);
  if (m) {
    const lat = Number(m[1]); const lng = Number(m[2]);
    const label = (await maps.reverseGeocodeAddress(lat, lng).catch(() => null)) || s;
    return { lat, lng, label };
  }

  if (key === 'home' || key === 'office') {
    const lat = user[`${key}_lat`]; const lng = user[`${key}_lng`];
    if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng), label: user[`${key}_address`] || key };
    const addr = user[`${key}_address`];
    if (!addr) return { error: 'PLACE_NOT_SET', detail: `The user hasn't saved their ${key} address. Ask for it.` };
    return geocodeOrError(addr, role);
  }

  return geocodeOrError(s, role);
}

async function geocodeOrError(address, role) {
  if (!config.maps.enabled) return { error: 'MAPS_NOT_CONFIGURED', detail: 'Cannot look up addresses right now. Ask the user to share the location pin on WhatsApp instead.' };
  try {
    const g = await maps.geocode(address);
    if (!g) return { error: 'ADDRESS_NOT_FOUND', detail: `Couldn't find "${address}". Ask the user for a fuller ${role} address (street + city) or a location pin.` };
    return { lat: g.lat, lng: g.lng, label: g.address };
  } catch (e) {
    return { error: 'ADDRESS_LOOKUP_FAILED', detail: e.message };
  }
}

function friendlyUberError(e) {
  if (e.code === 'UBER_NOT_CONFIGURED') return { error: 'RIDES_NOT_SET_UP', detail: 'Uber booking is not switched on yet. Tell the user it is coming soon.' };
  if (e.code === 'UBER_AUTH_FAILED') return { error: 'RIDES_UNAVAILABLE', detail: 'Uber sign-in for Wingman failed. Apologise; booking is temporarily unavailable.' };
  const msg = String(e.message || '');
  if (/distance|too far|exceed/i.test(msg)) return { error: 'TRIP_TOO_LONG', detail: msg };
  if (/unsupported|not available|outside|service area/i.test(msg)) return { error: 'NOT_AVAILABLE_HERE', detail: `Uber can't do this trip from here (${msg}).` };
  if (/fare/i.test(msg) && /expired|invalid/i.test(msg)) return { error: 'FARE_EXPIRED', detail: 'The quoted fare expired. Get fresh options.' };
  return { error: 'UBER_ERROR', detail: msg };
}

// ─── Link mode (no Uber business account) ───────────────────────────
// Uber's universal link opens the Uber app (or m.uber.com) with pickup and
// drop already set; the user taps once to book on their own account.
function uberLink(from, to, productId) {
  const q = new URLSearchParams({ action: 'setPickup' });
  if (config.uber.clientId) q.set('client_id', config.uber.clientId);
  q.set('pickup[latitude]', String(from.lat));
  q.set('pickup[longitude]', String(from.lng));
  q.set('pickup[nickname]', String(from.label || 'Pickup').slice(0, 60));
  q.set('pickup[formatted_address]', String(from.label || '').slice(0, 150));
  q.set('dropoff[latitude]', String(to.lat));
  q.set('dropoff[longitude]', String(to.lng));
  q.set('dropoff[nickname]', String(to.label || 'Destination').slice(0, 60));
  q.set('dropoff[formatted_address]', String(to.label || '').slice(0, 150));
  if (productId) q.set('product_id', productId);
  return `https://m.uber.com/ul/?${q.toString()}`;
}

function lyftLink(from, to) {
  const q = new URLSearchParams({ id: 'lyft' });
  q.set('pickup[latitude]', String(from.lat));
  q.set('pickup[longitude]', String(from.lng));
  q.set('destination[latitude]', String(to.lat));
  q.set('destination[longitude]', String(to.lng));
  return `https://lyft.com/ride?${q.toString()}`;
}

async function linkModeTrip(user, input) {
  const from = await resolvePlace(user, input.from || 'current', { role: 'pickup' });
  if (from.error) return from;
  const to = await resolvePlace(user, input.to, { role: 'destination' });
  if (to.error) return to;
  let drive = null;
  try {
    const d = await maps.directions(`${from.lat},${from.lng}`, `${to.lat},${to.lng}`);
    if (d && d.best && d.best.minutes) drive = d.best.minutes;
  } catch (_) { /* travel time is a nice-to-have */ }
  try {
    agentActions.log(user.id, { kind: 'ride.link', summary: `Uber link ${from.label} → ${to.label}`, source: 'chat' });
  } catch (_) { /* logging only */ }
  return {
    mode: 'link',
    pickup: from.label,
    destination: to.label,
    drive_minutes_now: drive,
    uber_link: uberLink(from, to),
    lyft_link: lyftLink(from, to),
    note: 'Wingman can\'t book directly yet. Send the Uber link (and Lyft as a backup): pickup and destination are already filled in — they tap it, check the fare and press Request in their own app (paid on their account). Mention the drive time if known. Do not claim it is booked, and do not promise driver updates — the Uber app shows those.',
  };
}

function splitName(user) {
  const parts = String(user.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Wingman', lastName: 'Guest' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || '.' };
}

async function getRideOptions(user, input) {
  const from = await resolvePlace(user, input.from || 'current', { role: 'pickup' });
  if (from.error) return from;
  const to = await resolvePlace(user, input.to, { role: 'destination' });
  if (to.error) return to;
  let options;
  try {
    options = await uber.estimates(from, to);
  } catch (e) {
    return friendlyUberError(e);
  }
  const usable = options.filter((o) => !o.no_cars);
  if (!usable.length) return { error: 'NO_CARS', detail: 'No Uber cars are available for this trip right now. Offer to try again in a few minutes.' };
  usable.sort((a, b) => (a.fare_value ?? 1e9) - (b.fare_value ?? 1e9));
  return {
    pickup: from.label,
    destination: to.label,
    options: usable.slice(0, 6).map((o) => ({
      product_id: o.product_id, name: o.name, fare: o.fare, fare_value: o.fare_value,
      pickup_in_min: o.pickup_eta_min, trip_minutes: o.trip_minutes, seats: o.capacity,
    })),
    note: 'Show the 2–3 best options (cheapest and quickest) with fare and pickup time; ask which to book. Fares are upfront and refreshed at booking.',
  };
}

async function bookRide(user, input) {
  const existing = rides.activeForUser(user.id);
  if (existing) {
    return { error: 'RIDE_ALREADY_ACTIVE', detail: `There is already an active ride (${existing.product_name || 'Uber'}, status ${existing.status}). Cancel it first if they want a new one.` };
  }
  const from = await resolvePlace(user, input.from || 'current', { role: 'pickup' });
  if (from.error) return from;
  const to = await resolvePlace(user, input.to, { role: 'destination' });
  if (to.error) return to;

  // Re-quote: the fare_id the user saw may have expired while they decided.
  let fresh;
  try {
    fresh = (await uber.estimates(from, to)).find((o) => o.product_id === input.product_id);
  } catch (e) {
    return friendlyUberError(e);
  }
  if (!fresh || fresh.no_cars) {
    return { error: 'PRODUCT_UNAVAILABLE', detail: `${input.product_name || 'That ride type'} isn't available right now. Get fresh options.` };
  }
  const approved = Number(input.fare_value);
  if (approved > 0 && fresh.fare_value != null && fresh.fare_value > approved * (1 + config.uber.maxFareRise)) {
    return {
      error: 'FARE_CHANGED',
      detail: `The fare went up from ${input.fare || approved} to ${fresh.fare}. Nothing was booked — ask the user if they still want it.`,
      new_fare: fresh.fare, new_fare_value: fresh.fare_value,
    };
  }

  let trip;
  try {
    trip = await uber.createTrip({
      guest: { ...splitName(user), phone: user.phone },
      pickup: { lat: from.lat, lng: from.lng, address: from.label },
      dropoff: { lat: to.lat, lng: to.lng, address: to.label },
      productId: fresh.product_id,
      fareId: fresh.fare_id,
      noteForDriver: input.note_for_driver,
    });
  } catch (e) {
    return friendlyUberError(e);
  }
  if (!trip.request_id) return { error: 'UBER_ERROR', detail: 'Uber did not return a trip id.' };

  const row = rides.create({
    userId: user.id,
    requestId: trip.request_id,
    status: trip.status || 'processing',
    productName: fresh.name,
    fare: fresh.fare,
    pickupLabel: from.label, pickupLat: from.lat, pickupLng: from.lng,
    dropoffLabel: to.label, dropoffLat: to.lat, dropoffLng: to.lng,
  });
  rides.updateFromTrip(row.id, trip);
  try {
    agentActions.log(user.id, { kind: 'ride.booked', summary: `Booked ${fresh.name} ${from.label} → ${to.label} (${fresh.fare || 'fare n/a'})`, source: 'chat' });
  } catch (_) { /* logging only */ }

  return {
    booked: true,
    ride: fresh.name,
    fare: fresh.fare,
    pickup: from.label,
    destination: to.label,
    status: trip.status,
    driver: trip.driver_name ? { name: trip.driver_name, car: trip.vehicle, plate: trip.plate, minutes_away: trip.eta_min } : null,
    note: 'Booked. Uber is finding a driver. Tell the user briefly; Wingman will message them the driver, car and plate as soon as one accepts, when the driver is close, and when the cab arrives.',
  };
}

function describe(r) {
  if (!r) return null;
  return {
    ride: r.product_name, status: r.status, fare: r.fare,
    pickup: r.pickup_label, destination: r.dropoff_label,
    driver: r.driver_name || null, driver_phone: r.driver_phone || null,
    car: r.vehicle || null, plate: r.plate || null, minutes_away: r.eta_min,
    tracking_link: r.share_url || null,
  };
}

async function getRideStatus(user) {
  const r = rides.activeForUser(user.id) || rides.latestForUser(user.id);
  if (!r) return { error: 'NO_RIDE', detail: 'No ride booked through Wingman yet.' };
  if (rides.ACTIVE.includes(r.status) && r.request_id) {
    try {
      const t = await uber.getTrip(r.request_id);
      return { ...describe(rides.updateFromTrip(r.id, t)), live: true };
    } catch (_) { /* fall back to what we stored */ }
  }
  return describe(r);
}

async function cancelRide(user) {
  const r = rides.activeForUser(user.id);
  if (!r) return { error: 'NO_ACTIVE_RIDE', detail: 'There is no active ride to cancel.' };
  try {
    await uber.cancelTrip(r.request_id);
  } catch (e) {
    return friendlyUberError(e);
  }
  rides.setStatus(r.id, 'rider_canceled');
  rides.markNotified(r.id, 'done');
  try { agentActions.log(user.id, { kind: 'ride.canceled', summary: `Cancelled ${r.product_name || 'Uber'} to ${r.dropoff_label}`, source: 'chat' }); } catch (_) {}
  return { canceled: true, ride: r.product_name, destination: r.dropoff_label };
}

async function executeRideTool(user, { name, input = {} }) {
  if (!config.uber.enabled) {
    if (name === 'get_ride_options' || name === 'book_ride') return linkModeTrip(user, input);
    return { error: 'NOT_TRACKED', detail: 'Rides are booked in the user\'s own Uber app for now, so Wingman can\'t see or cancel them. Tell them to check or cancel in the Uber app.' };
  }
  switch (name) {
    case 'get_ride_options': return getRideOptions(user, input);
    case 'book_ride': return bookRide(user, input);
    case 'get_ride_status': return getRideStatus(user);
    case 'cancel_ride': return cancelRide(user);
    default: return { error: `Unknown ride tool: ${name}` };
  }
}

module.exports = { executeRideTool, resolvePlace };
