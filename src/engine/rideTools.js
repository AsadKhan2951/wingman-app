'use strict';

/**
 * Ride tools — book an Uber for the user (Uber Guest Rides API).
 *
 * Flow: get_ride_options (fares + pickup ETA) → user picks / says yes →
 * book_ride (server-side approval gate: it spends money) → the ride tracker
 * messages the user on WhatsApp: driver details, "2 min away", "your cab is
 * here", and when they've arrived.
 */
const PLACE =
  '"current" (where the user is NOW — from the location they shared on WhatsApp or the app), ' +
  '"home", "office", a full address, or "lat,lng".';

const rideTools = [
  {
    name: 'get_ride_options',
    description:
      'Uber ride options for a trip: each product (UberX, Comfort, Black, XL…) with its upfront fare ' +
      'and how many minutes until pickup. Use when the user wants a cab/Uber/ride/taxi ' +
      '("cab book karo", "get me an Uber to my meeting"). Pickup defaults to where they are now. ' +
      'If they did not say where to, ASK first (or offer the location of their next calendar meeting). ' +
      'If this returns NEED_LOCATION or LOCATION_STALE, ask them to share their current location on ' +
      'WhatsApp (📎 → Location → Send your current location) or tell you the pickup address, then call again. ' +
      'Show 2–3 sensible options (cheapest + fastest) with fare and pickup time, then ask which one to book.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: `Destination: ${PLACE}` },
        from: { type: 'string', description: `Pickup: ${PLACE} Defaults to "current".` },
      },
      required: ['to'],
    },
  },
  {
    name: 'book_ride',
    description:
      'Book the Uber the user chose. It costs money, so it always waits for the user\'s yes: show ' +
      'product, pickup, destination and fare and ask them to confirm. Pass the product_id, name and fare ' +
      'from get_ride_options. After it is booked, Wingman messages the user on WhatsApp by itself with ' +
      'the driver, car and plate, when the driver is close, and when the cab has arrived — tell them that.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: `Destination, same as for get_ride_options: ${PLACE}` },
        from: { type: 'string', description: `Pickup, same as for get_ride_options. Defaults to "current".` },
        product_id: { type: 'string', description: 'product_id of the chosen option.' },
        product_name: { type: 'string', description: 'Its name, e.g. "UberX".' },
        fare: { type: 'string', description: 'The fare shown to the user, e.g. "$23.40".' },
        fare_value: { type: 'number', description: 'The numeric fare from get_ride_options (fare_value).' },
        note_for_driver: { type: 'string', description: 'Optional pickup note, e.g. "Main lobby, 5th Ave side".' },
      },
      required: ['to', 'product_id'],
    },
  },
  {
    name: 'get_ride_status',
    description:
      'Status of the user\'s current/last Uber: driver, car, plate, minutes away, or that it is on the way / done. ' +
      'Use for "cab kahan hai?", "where is my Uber?", "driver ka number?".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_ride',
    description:
      'Cancel the user\'s active Uber. Waits for their yes (Uber may charge a cancellation fee once a driver is on the way — say so).',
    input_schema: { type: 'object', properties: {} },
  },
];

const rideToolNames = new Set(rideTools.map((t) => t.name));

module.exports = { rideTools, rideToolNames };
