'use strict';

const express = require('express');
const googleAuth = require('./googleAuth');
const wa = require('../whatsapp/client');
const linkSig = require('../utils/linkSig');

const router = express.Router();

const STALE_LINK_HTML = `
  <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
    <h2>This link has expired</h2>
    <p>Ask Wingman on WhatsApp for a fresh connect link (or connect from the app).</p>
  </body></html>`;

/**
 * GET /auth/google?phone=9715XXXXXXX
 * Redirects the user to Google's consent screen (calendar + gmail + drive + tasks).
 */
router.get('/auth/google', (req, res) => {
  const phone = (req.query.phone || '').toString();
  if (!phone) {
    return res.status(400).send('Missing phone parameter.');
  }
  if (!linkSig.canStartConnect(req, phone)) return res.status(403).send(STALE_LINK_HTML);
  // ?hint=<email> pre-selects the account that needs reconnecting.
  const hint = /^[^@\s]{1,64}@[^@\s]{1,190}$/.test(String(req.query.hint || '')) ? String(req.query.hint) : null;
  const url = googleAuth.getAuthUrl(phone, undefined, { loginHint: hint });
  res.redirect(url);
});

/**
 * GET /auth/google/health?phone=9715XXXXXXX
 * Health has its own consent so connecting Calendar never asks for health data,
 * and a user can grant one without the other.
 */
router.get('/auth/google/health', (req, res) => {
  const phone = (req.query.phone || '').toString();
  if (!phone) return res.status(400).send('Missing phone parameter.');
  if (!linkSig.canStartConnect(req, phone)) return res.status(403).send(STALE_LINK_HTML);
  res.redirect(googleAuth.getHealthAuthUrl(phone));
});

/**
 * GET /auth/google/callback?code=...&state=<phone>[|health]
 * Exchanges the code for tokens, stores them, confirms via WhatsApp, and
 * kicks off an initial email scan when Gmail was connected.
 */
router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Authorization failed: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  // The state is signed when the flow starts; a forged or replayed one (e.g.
  // someone else's phone with the attacker's own Google code) is refused.
  const rawState = linkSig.verifyState((state || '').toString());
  if (rawState === null) return res.status(400).send(STALE_LINK_HTML);
  const isHealthFlow = rawState.endsWith('|health');
  const phone = isHealthFlow ? rawState.slice(0, -'|health'.length) : rawState;

  // Health consent comes back through the same callback; handle it separately
  // so it never touches the calendar/gmail token columns.
  if (isHealthFlow) {
    try {
      const user = await googleAuth.handleHealthCallback(code.toString(), phone);

      // Pull the first batch now so the user sees data immediately rather than
      // waiting for the next scheduled sync.
      let firstSync = { saved: 0 };
      try {
        firstSync = await require('../services/googleHealth').syncUser(user.id, { days: 14 });
      } catch (e) {
        console.warn('[auth] initial health sync failed:', e.message);
      }

      try {
        if (wa.ready() && phone) {
          await wa.sendMessage(
            phone,
            firstSync.saved
              ? `Health connected ✅ I pulled in ${firstSync.saved} recent readings.\n\nTry asking: "how did I sleep?"`
              : 'Health connected ✅\n\nNo readings yet — they\'ll appear once your phone or watch syncs with Google.'
          );
        }
      } catch (waErr) {
        console.warn('[auth] health confirmation failed:', waErr.message);
      }

      return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
          <h2>✅ Health connected!</h2>
          <p>${firstSync.saved ? `${firstSync.saved} recent readings pulled in.` : 'Readings will appear as your device syncs with Google.'}</p>
          <p>You can close this tab and head back to WhatsApp.</p>
        </body></html>
      `);
    } catch (err) {
      console.error('[auth] Health callback error:', err);
      return res.status(500).send(`Failed to connect Google Health: ${err.message}`);
    }
  }

  try {
    const user = await googleAuth.handleCallback(code.toString(), phone);

    const calConnected = googleAuth.isConnected(user);
    const emailConnected = googleAuth.isEmailConnected(user);
    let taskSync = null;
    try { taskSync = await require('../services/googleTasks').syncUser(user.id); }
    catch (e) { console.warn('[auth] initial Google Tasks sync failed:', e.message); }

    // Best-effort WhatsApp confirmations
    try {
      if (wa.ready() && phone) {
        if (calConnected) {
          await wa.sendMessage(phone, "Calendar connected! \u2713 Try asking me \"what's my schedule tomorrow?\"");
        }
        if (emailConnected) {
          await wa.sendMessage(phone, "Email connected! \u2713 I'll start scanning your inbox now.");
        }
        if (taskSync && (taskSync.imported || taskSync.updated || taskSync.completed)) {
          await wa.sendMessage(phone, `Google Tasks connected! \u2713 Imported ${taskSync.imported} task(s).`);
        }
      }
    } catch (waErr) {
      console.warn('[auth] Could not send WhatsApp confirmation:', waErr.message);
    }

    // Kick off an initial inbox scan (non-blocking)
    if (emailConnected) {
      try {
        const emailScanner = require('../services/emailScanner');
        emailScanner.scanUser(user.id).catch((e) =>
          console.warn('[auth] initial scan failed:', e.message)
        );
      } catch (e) {
        console.warn('[auth] could not start initial scan:', e.message);
      }
    }

    // "Getting to know you" — first-run deep analysis across all connected data
    // (Gmail, Calendar, Tasks, health, business). Fire-and-forget so the OAuth
    // redirect isn't blocked; it starts a 7-day calibration window.
    if (calConnected || emailConnected) {
      try {
        require('../services/onboardingAnalyzer').start(user.id).catch((e) =>
          console.warn('[auth] onboarding start failed:', e.message)
        );
      } catch (e) {
        console.warn('[auth] could not start onboarding:', e.message);
      }
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>✅ Google account connected!</h2>
        <p>${calConnected ? 'Calendar' : ''}${calConnected && emailConnected ? ' &amp; ' : ''}${emailConnected ? 'Gmail' : ''}${(calConnected || emailConnected) && taskSync ? ' &amp; ' : ''}${taskSync ? 'Google Tasks' : ''} linked to Wingman.</p>
        <p>You can close this tab and head back to WhatsApp.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[auth] Callback error:', err);
    res.status(500).send(`Failed to connect Google account: ${err.message}`);
  }
});

/**
 * GET /auth/wearable/callback?code=…&state=<phone>:<provider>
 *
 * MUST stay above '/auth/wearable/:provider' — Express matches in order, and
 * the parameterised route would otherwise swallow this one as provider="callback".
 */
router.get('/auth/wearable/callback', async (req, res) => {
  const wearables = require('../services/wearables');
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Authorization failed: ${error}`);
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    const verified = linkSig.verifyState((state || '').toString());
    if (verified === null) return res.status(400).send(STALE_LINK_HTML);
    const { user, provider } = await wearables.handleCallback(code.toString(), verified);

    // Pull straight away so the user sees data now, not after the next tick.
    let saved = 0;
    try {
      const r = await wearables.syncOne(user.id, provider.id, { days: 14 });
      saved = r.saved || 0;
    } catch (e) {
      console.warn('[auth] initial wearable sync failed:', e.message);
    }

    try {
      const phone = String(user.phone || '').replace(/[^0-9]/g, '');
      if (wa.ready() && phone) {
        await wa.sendMessage(
          phone,
          saved
            ? `${provider.label} connected ✅ I pulled in ${saved} recent readings.\n\nTry asking: "how did I sleep?"`
            : `${provider.label} connected ✅\n\nNo readings yet — they'll appear once your device syncs.`
        );
      }
    } catch (waErr) {
      console.warn('[auth] wearable confirmation failed:', waErr.message);
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>✅ ${provider.label} connected!</h2>
        <p>${saved ? `${saved} recent readings pulled in.` : 'Readings will appear as your device syncs.'}</p>
        <p>You can close this tab and head back to WhatsApp.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[auth] wearable callback error:', err.message);
    res.status(500).send(`Could not complete the connection: ${err.message}`);
  }
});

/**
 * GET /auth/wearable/:provider?phone=…
 * One route for every wearable brand — the provider registry supplies the rest.
 * Registered AFTER the callback above, deliberately.
 */
router.get('/auth/wearable/:provider', (req, res) => {
  const wearables = require('../services/wearables');
  // Belt and braces: even if these routes are ever reordered, 'callback' must
  // never be treated as a provider name.
  if (req.params.provider === 'callback') return res.status(400).send('Invalid callback.');

  const phone = (req.query.phone || '').toString();
  if (!phone) return res.status(400).send('Missing phone parameter.');
  if (!linkSig.canStartConnect(req, phone)) return res.status(403).send(STALE_LINK_HTML);

  try {
    res.redirect(wearables.connectUrl(req.params.provider, phone));
  } catch (err) {
    if (err.message === 'PROVIDER_NOT_CONFIGURED') {
      return res.status(503).send('That device is not set up on this server yet.');
    }
    return res.status(400).send('Unknown device.');
  }
});

/**
 * GET /auth/shopify?shop=mystore.myshopify.com&phone=9231XXXXXXX
 * Sends the merchant to Shopify's consent screen.
 */
router.get('/auth/shopify', (req, res) => {
  const config = require('../config');
  const shopifyAuth = require('./shopifyAuth');

  if (!config.shopify.enabled) {
    return res.status(503).send('Shopify connect is not configured on this server yet.');
  }
  const shop = shopifyAuth.normalizeShop(req.query.shop);
  const phone = (req.query.phone || '').toString();
  if (!shopifyAuth.isValidShop(shop)) {
    return res.status(400).send('Please provide a valid store domain, e.g. mystore.myshopify.com');
  }
  if (!phone) return res.status(400).send('Missing phone parameter.');
  if (!linkSig.canStartConnect(req, phone)) return res.status(403).send(STALE_LINK_HTML);

  // The phone rides in a SIGNED `state` so the callback can attach the store to
  // the right user (same pattern as the Google flow).
  res.redirect(shopifyAuth.buildAuthUrl(shop, linkSig.signState(phone)));
});

/**
 * GET /auth/shopify/callback
 * Verifies Shopify's signature, swaps the code for an access token, and stores it.
 */
router.get('/auth/shopify/callback', async (req, res) => {
  const shopifyAuth = require('./shopifyAuth');
  const usersRepo = require('../db/users');

  const { code, shop: rawShop, state } = req.query;
  const shop = shopifyAuth.normalizeShop(rawShop);
  const phone = linkSig.verifyState((state || '').toString());
  if (phone === null) return res.status(400).send(STALE_LINK_HTML);

  if (!code || !shopifyAuth.isValidShop(shop)) {
    return res.status(400).send('Invalid Shopify callback.');
  }
  // Reject forged callbacks — without this anyone could attach a store to a user.
  if (!shopifyAuth.verifyHmac(req.query)) {
    return res.status(400).send('Could not verify this request came from Shopify.');
  }

  try {
    const { accessToken } = await shopifyAuth.exchangeCode(shop, code.toString());

    const user = usersRepo.getByPhone(phone);
    if (!user) return res.status(400).send('No Wingman account found for that number.');
    usersRepo.update(user.id, { shopify_domain: shop, shopify_token: accessToken });

    // Start studying the store right away (first look in minutes, full picture
    // within a week) — the study service tells the user the timeline itself.
    try { require('../services/appStudy').noticeBuiltins(usersRepo.getById(user.id), { justConnected: true }); }
    catch (e) { console.warn('[auth] could not start Shopify study:', e.message); }

    try {
      // When app study is on, its own "connected ✅ — here's how I'll learn it"
      // message covers this; don't send two confirmations.
      if (wa.ready() && phone && !require('../services/appStudy').enabled()) {
        await wa.sendMessage(phone, `Shopify connected ✅ (${shop})\n\nTry asking me: "how are sales today?"`);
      }
    } catch (waErr) {
      console.warn('[auth] Shopify confirmation failed:', waErr.message);
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>✅ Shopify connected!</h2>
        <p><b>${shop}</b> is now linked to Wingman.</p>
        <p>You can close this tab — try asking “how are sales today?” on WhatsApp.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[auth] Shopify callback error:', err.message);
    res.status(500).send('Could not complete the Shopify connection. Please try again.');
  }
});

module.exports = router;
