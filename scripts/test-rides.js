'use strict';
/**
 * Offline checks for Uber ride booking (fake Uber + Maps, temp DB, WhatsApp
 * stubbed — nothing real is booked or sent).
 *   node scripts/test-rides.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-rides-'));
process.env.DATABASE_PATH = path.join(tmp, 't.db');
process.env.DISABLE_WHATSAPP = '1';
for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'ELEVENLABS_API_KEY', 'COMPOSIO_API_KEY']) delete process.env[k];
process.env.UBER_CLIENT_ID = 'cid';
process.env.UBER_CLIENT_SECRET = 'secret';
process.env.UBER_ORG_ID = 'org-1';
process.env.UBER_SANDBOX = '1';
process.env.MAPS_API_KEY = 'maps';

// ── fake Uber + Google Maps ─────────────────────────────────────────
const calls = [];
let fares = { x: 23.4, comfort: 31.2 };
let tripStates = [];
let tokenCalls = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  const json = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.includes('auth.uber.com')) { tokenCalls++; return json(200, { access_token: 'tok', expires_in: 2592000 }); }
  if (u.includes('maps.googleapis.com')) {
    if (u.includes('latlng=')) return json(200, { status: 'OK', results: [{ formatted_address: '350 5th Ave, New York, NY', address_components: [] }] });
    return json(200, { status: 'OK', results: [{ formatted_address: '1 World Trade Center, New York, NY', geometry: { location: { lat: 40.7127, lng: -74.0134 } } }] });
  }
  if (u.endsWith('/v1/guests/trips/estimates')) {
    return json(200, {
      product_estimates: [
        { product: { product_id: 'p-comfort', display_name: 'Comfort', capacity: 4 }, estimate_info: { fare: { fare_id: 'f-c', display: `$${fares.comfort}`, value: fares.comfort, currency_code: 'USD' }, pickup_estimate: 5 } },
        { product: { product_id: 'p-x', display_name: 'UberX', capacity: 4 }, estimate_info: { fare: { fare_id: 'f-x', display: `$${fares.x}`, value: fares.x, currency_code: 'USD' }, pickup_estimate: 3 } },
      ],
    });
  }
  if (u.endsWith('/v1/guests/trips') && opts.method === 'POST') return json(200, { request_id: 'trip-1', status: 'processing' });
  if (/\/v1\/guests\/trips\/trip-\d$/.test(u) && opts.method === 'DELETE') return json(204, {});
  if (/\/v1\/guests\/trips\/trip-\d$/.test(u)) return json(200, tripStates.length > 1 ? tripStates.shift() : tripStates[0]);
  return json(404, { message: 'not found' });
};

const wa = require('../src/whatsapp/client');
const sent = [];
wa.sendMessage = async (phone, text) => { sent.push(text); return { ok: true }; };

const db = require('../src/db');
db.initSchema();
const users = require('../src/db/users');
const rides = require('../src/db/rides');
const conversations = require('../src/db/conversations');
require('../src/engine/conversation'); // registers the built-in runner for approvals
const { executeRideTool } = require('../src/engine/rideExecutor');
const gate = require('../src/engine/integrationExecutor');
const tracker = require('../src/services/rideTracker');
const uber = require('../src/services/uber');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  let user = users.create({ phone: '923001112223' });
  users.update(user.id, { name: 'Aamir Younus', onboarding_complete: 1 });
  user = users.getById(user.id);

  // 1. No location yet → ask for it.
  const r0 = await executeRideTool(user, { name: 'get_ride_options', input: { to: 'One World Trade Center' } });
  check('no location → NEED_LOCATION (ask to share on WhatsApp)', r0.error === 'NEED_LOCATION' && /Location/.test(r0.detail));

  // 2. Old location → don't trust it.
  users.update(user.id, { current_lat: 40.748, current_lng: -73.985, current_location_label: 'Midtown, New York', current_location_at: new Date(Date.now() - 3 * 3600e3).toISOString() });
  const r1 = await executeRideTool(users.getById(user.id), { name: 'get_ride_options', input: { to: 'One World Trade Center' } });
  check('3-hour-old location → LOCATION_STALE', r1.error === 'LOCATION_STALE');

  // 3. Fresh location → options, cheapest first.
  users.update(user.id, { current_location_at: new Date().toISOString() });
  user = users.getById(user.id);
  const opt = await executeRideTool(user, { name: 'get_ride_options', input: { to: 'One World Trade Center' } });
  check('options: cheapest first, fare + pickup ETA', opt.options && opt.options[0].name === 'UberX' && opt.options[0].fare === '$23.4' && opt.options[0].pickup_in_min === 3, JSON.stringify(opt.options && opt.options[0]));
  check('…pickup/destination labels shown', opt.pickup === 'Midtown, New York' && /World Trade/.test(opt.destination));
  const est = calls.find((c) => c.url.endsWith('/estimates'));
  check('sandbox URL + bearer + org header', est.url.startsWith('https://sandbox-api.uber.com') && est.headers.Authorization === 'Bearer tok' && est.headers['x-uber-organizationuuid'] === 'org-1');

  // 4. Booking never runs without a yes (even with Composio off).
  const input = { to: 'One World Trade Center', product_id: 'p-x', product_name: 'UberX', fare: '$23.4', fare_value: 23.4 };
  let ran = false;
  const g = await gate.gateBuiltin(user, 'book_ride', input, {}, async () => { ran = true; });
  check('book_ride → approval_required, nothing booked', g.approval_required && !ran && !calls.some((c) => c.url.endsWith('/v1/guests/trips') && c.method === 'POST'), g.app);
  const early = await gate.executeIntegrationTool(user, { name: 'approve_integration_action', input: { action_id: g.action_id } }, {});
  check('approve before the user replied → refused', early.error === 'NEEDS_USER_CONFIRMATION' || early.error === 'UNKNOWN_TOOL' || !!early.error);
  const auto = await gate.gateBuiltin(user, 'book_ride', input, { automated: true }, async () => { ran = true; });
  check('automated run (call/email) cannot book', !ran && (auto.approval_required || auto.error));

  // 5. User says yes → approve → booked.
  await new Promise((r) => setTimeout(r, 1100));
  conversations.logInbound({ userId: user.id, content: 'haan book kar do', phoneNumber: user.phone, waMessageId: 'w1' });
  tripStates = [{ request_id: 'trip-1', status: 'processing' }];
  const ok = await gate.executeIntegrationTool(user, { name: 'approve_integration_action', input: { action_id: g.action_id } }, {});
  let ride = rides.latestForUser(user.id);
  const post = calls.find((c) => c.url.endsWith('/v1/guests/trips') && c.method === 'POST');
  const body = post ? JSON.parse(post.body) : {};
  check('after yes → trip created', !!ride && ride.request_id === 'trip-1' && ride.product_name === 'UberX', JSON.stringify(ok).slice(0, 160));
  check('…guest = the user (name + E.164 phone), fresh fare_id', body.guest && body.guest.first_name === 'Aamir' && body.guest.last_name === 'Younus' && body.guest.phone_number === '+923001112223' && body.fare_id === 'f-x' && body.product_id === 'p-x');
  const again = await executeRideTool(user, { name: 'book_ride', input });
  check('second booking while one is active → refused', again.error === 'RIDE_ALREADY_ACTIVE');

  // 6. Tracker: driver assigned → close → arrived → trip → done, each once.
  const drv = { name: 'Carlos Diaz', phone_number: '+12125550100', rating: 4.9 };
  const veh = { make: 'Toyota', model: 'Camry', license_plate: 'T123456C', vehicle_color_name: 'Black' };
  tripStates = [{ request_id: 'trip-1', status: 'accepted', driver: drv, vehicle: veh, pickup: { eta: 6 } }];
  await tracker.runOnce();
  check('driver accepted → name, car, plate, ETA sent', sent.length === 1 && /Carlos Diaz/.test(sent[0]) && /T123456C/.test(sent[0]) && /Black Toyota Camry/.test(sent[0]) && /6 min/.test(sent[0]), sent[0]);
  await tracker.runOnce();
  check('…not sent twice', sent.length === 1);
  tripStates = [{ request_id: 'trip-1', status: 'accepted', driver: drv, vehicle: veh, pickup: { eta: 2 } }];
  await tracker.runOnce();
  check('2 min away → heads-up', sent.length === 2 && /2 min away/.test(sent[1]));
  tripStates = [{ request_id: 'trip-1', status: 'arriving', driver: drv, vehicle: veh, pickup: { eta: 0 } }];
  await tracker.runOnce();
  check('arriving → "Your cab is here" with plate', sent.length === 3 && /Your cab is here/.test(sent[2]) && /T123456C/.test(sent[2]));
  tripStates = [{ request_id: 'trip-1', status: 'in_progress', driver: drv, vehicle: veh }];
  await tracker.runOnce();
  check('trip started → no extra message', sent.length === 3);
  tripStates = [{ request_id: 'trip-1', status: 'completed', driver: drv, vehicle: veh, fare: { display: '$24.10' } }];
  await tracker.runOnce();
  ride = rides.getById(ride.id);
  check('completed → arrival + fare, ride closed', sent.length === 4 && /arrived/.test(sent[3]) && /\$24.10/.test(sent[3]) && ride.status === 'completed' && !!ride.finished_at, sent[3]);
  await tracker.runOnce();
  check('finished rides are not polled again', sent.length === 4 && rides.listActive().length === 0);

  // 7. Status question.
  const st = await executeRideTool(user, { name: 'get_ride_status', input: {} });
  check('get_ride_status → last ride with driver + plate', st.driver === 'Carlos Diaz' && st.plate === 'T123456C' && st.status === 'completed');

  // 8. Fare jumped while the user was deciding → don't book, ask again.
  fares = { x: 35, comfort: 40 };
  const fc = await executeRideTool(user, { name: 'book_ride', input });
  check('fare rose >15% → FARE_CHANGED, nothing booked', fc.error === 'FARE_CHANGED' && fc.new_fare === '$35');

  // 9. Driver cancels → offer to rebook; then the user cancels a new ride.
  fares = { x: 23.4, comfort: 31.2 };
  tripStates = [{ request_id: 'trip-1', status: 'processing' }];
  const b2 = await executeRideTool(user, { name: 'book_ride', input });
  check('new booking after the last one finished', b2.booked === true);
  tripStates = [{ request_id: 'trip-1', status: 'driver_canceled' }];
  await tracker.runOnce();
  check('driver cancelled → user told, offered another', /driver cancelled/.test(sent[sent.length - 1]));
  tripStates = [{ request_id: 'trip-1', status: 'processing' }];
  await executeRideTool(user, { name: 'book_ride', input });
  const cx = await executeRideTool(user, { name: 'cancel_ride', input: {} });
  check('cancel_ride → Uber DELETE + ride closed', cx.canceled === true && calls.some((c) => c.method === 'DELETE') && !rides.activeForUser(user.id));
  const cg = await gate.gateBuiltin(user, 'cancel_ride', {}, {}, async () => {});
  check('cancel_ride also waits for a yes', cg.approval_required === true);

  // 10. Webhook signature + nudge.
  const raw = Buffer.from(JSON.stringify({ meta: { resource_id: 'trip-1' } }));
  const sig = crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
  check('webhook: valid signature accepted, forged rejected', uber.verifyWebhook(raw, sig) && !uber.verifyWebhook(raw, 'deadbeef'.repeat(8)));
  check('token cached (one auth call for the whole run)', tokenCalls === 1, `auth calls: ${tokenCalls}`);

  // 11. No Uber business account → link mode: Uber/Lyft links, nothing booked.
  delete process.env.UBER_CLIENT_ID;
  uber._resetToken();
  const before = calls.filter((c) => c.url.includes('/v1/guests/')).length;
  const lk = await executeRideTool(user, { name: 'get_ride_options', input: { to: 'One World Trade Center' } });
  const u = lk.uber_link ? new URL(lk.uber_link) : null;
  check('link mode → Uber link with pickup + drop filled in', lk.mode === 'link' && u && u.host === 'm.uber.com'
    && u.searchParams.get('pickup[latitude]') === '40.748' && u.searchParams.get('dropoff[latitude]') === '40.7127', lk.uber_link);
  check('…Lyft backup link too', /^https:\/\/lyft\.com\/ride\?/.test(lk.lyft_link || ''));
  const lb = await executeRideTool(user, { name: 'book_ride', input });
  check('…book_ride also gives the link, no Uber API call', lb.mode === 'link' && calls.filter((c) => c.url.includes('/v1/guests/')).length === before);
  const ls = await executeRideTool(user, { name: 'get_ride_status', input: {} });
  check('…status/cancel say "check the Uber app"', ls.error === 'NOT_TRACKED');

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
