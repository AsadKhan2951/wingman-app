'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');

// Serve the new app (app/dist) when it's built, else the legacy dashboard (client/dist).
const appDist = path.resolve(__dirname, '..', 'app', 'dist');
const legacyDist = path.resolve(__dirname, '..', 'client', 'dist');
const uiDist = fs.existsSync(path.join(appDist, 'index.html')) ? appDist : legacyDist;

// Parse a JSON env var; a malformed value logs and falls back rather than
// crashing boot (a feature with bad config degrades, it doesn't take us down).
function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) {
    console.warn(`[config] ${name} is not valid JSON — ignoring it (${e.message})`);
    return fallback;
  }
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    // Main chat engine — Sonnet 5: smart + fast + reasonable cost (WhatsApp).
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    // Deep reasoning (proactive brain, goal planning) — Opus 5.
    modelDeep: process.env.ANTHROPIC_MODEL_DEEP || 'claude-opus-5',
    // Cheap / high-volume (email classify, behaviour learning) — Haiku 4.5.
    modelCheap: process.env.ANTHROPIC_MODEL_CHEAP || 'claude-haiku-4-5',
  },

  database: {
    // Resolve relative to project root regardless of cwd
    path: path.resolve(
      __dirname,
      '..',
      process.env.DATABASE_PATH || './data/wingman.db'
    ),
  },

  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',

  // Password for every admin/debug route (/admin/qr, /_diag/*, /send,
  // /trigger, /conversations…). NO default: when it is unset those routes are
  // closed (they used to fall back to 'wingman', or to "open").
  adminPassword: process.env.ADMIN_PASSWORD || '',

  phone: {
    // Country code assumed for numbers stored/typed WITHOUT one (03001234567,
    // 3001234567 — old rows). Full international numbers always match exactly;
    // this only decides which country a bare 10-digit number belongs to.
    legacyCountryCode: (process.env.LEGACY_PHONE_COUNTRY_CODE ?? '92').replace(/\D/g, ''),
  },

  security: {
    // Signs connect links (/auth/google?phone=…&sig=…) and OAuth `state`, so
    // nobody can attach their own Google/Shopify account to someone else's
    // number. Falls back to SECRET_KEY / SESSION_SECRET.
    linkSecret: process.env.LINK_SECRET || process.env.SECRET_KEY || process.env.SESSION_SECRET || '',
    // Fallback material when no secret is set at all, so links stay valid
    // across restarts (a warning is logged). Set SECRET_KEY instead.
    linkSecretFallback: `${process.env.GOOGLE_CLIENT_SECRET || ''}|${process.env.ANTHROPIC_API_KEY || ''}`,
    // Set SIGNED_CONNECT_LINKS=0 only to debug; unsigned connect links are refused.
    signedConnectLinks: process.env.SIGNED_CONNECT_LINKS !== '0',
  },

  // Built dashboard (Vite) output served by Express in production
  clientDist: uiDist,

  // Disable WhatsApp entirely (useful for API-only / screenshot demos)
  disableWhatsapp: process.env.DISABLE_WHATSAPP === '1',

  auth: {
    // How OTPs are delivered: 'whatsapp' (via Wingman's own number) with a dev
    // fallback that surfaces the code in the API response / logs when WhatsApp
    // is not connected. Never used in production once WhatsApp is live.
    otpTtlSeconds: parseInt(process.env.OTP_TTL_SECONDS, 10) || 300,
    sessionTtlDays: parseInt(process.env.SESSION_TTL_DAYS, 10) || 30,
    // When true, include the OTP code in the request-otp API response so the
    // web app can be tested without a live WhatsApp pairing. Defaults to true
    // in development, false in production.
    exposeOtpInDev: process.env.EXPOSE_OTP_IN_DEV
      ? process.env.EXPOSE_OTP_IN_DEV === '1'
      : (process.env.NODE_ENV !== 'production'),
  },

  // Sign up / sign in (accounts): email + password always; Google and Apple
  // when configured. After signing up, the WhatsApp number is verified by OTP
  // and the account is linked to the Wingman user (users table, by phone).
  signin: {
    // The native app's URL scheme: Google/Apple sign-ins started from the app
    // (…/start?app=1) are sent back to <scheme>://auth-callback?code=…
    appScheme: process.env.APP_URL_SCHEME || 'ai.imyourwingman.app',
    google: {
      // A Google OAuth client with the "openid email profile" scopes only.
      // Falls back to the main Google client (add the callback URL to it).
      clientId: process.env.GOOGLE_SIGNIN_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_SIGNIN_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
      get enabled() {
        return !!(process.env.GOOGLE_SIGNIN_CLIENT_ID || process.env.GOOGLE_SIGNIN_ENABLED === '1')
          && !!(this.clientId && this.clientSecret);
      },
    },
    apple: {
      teamId: process.env.APPLE_TEAM_ID || '',
      servicesId: process.env.APPLE_SERVICES_ID || '',   // e.g. ai.imyourwingman.signin
      keyId: process.env.APPLE_KEY_ID || '',
      // The .p8 key's contents; newlines may be written as \n in .env.
      privateKey: String(process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      get enabled() { return !!(this.teamId && this.servicesId && this.keyId && this.privateKey); },
    },
  },

  // Wingman's OWN WhatsApp number (the assistant's number users message).
  // Purely informational (shown in the UI); pairing is done via /admin/qr.
  // Also used for the sign-in "message Wingman" link (wa.me), so it defaults to
  // the live number.
  wingmanNumber: process.env.WINGMAN_NUMBER || '+1 646 862 7900',

  // Contact email shown on the public Privacy Policy page (/privacy).
  privacyContactEmail: process.env.PRIVACY_CONTACT_EMAIL || 'wehearyou.studio@gmail.com',
  // The public privacy policy (landing/privacy/index.html on the website).
  // /privacy on the app domain redirects here.
  privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || 'https://imyourwingman.ai/privacy/',

  // WhatsApp Business Cloud API (official Meta API). When token + phoneNumberId
  // are set, Wingman uses this instead of whatsapp-web.js (no Chromium, real
  // phone numbers in webhooks, reliable on cloud hosts like Railway).
  whatsappCloud: {
    token: process.env.WHATSAPP_TOKEN || '',
    // Meta App Secret — used to verify X-Hub-Signature-256 on every webhook
    // POST. Unset → webhooks are accepted unverified (a warning is logged).
    appSecret: process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    // Shared secret we choose; must match the value entered in the Meta
    // webhook config so Meta's verification GET succeeds.
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'wingman_verify',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v25.0',
    // Approved AUTHENTICATION template used to deliver login OTPs to users who
    // are outside the 24h customer-service window (i.e. brand-new users).
    otpTemplate: process.env.OTP_TEMPLATE_NAME || 'wingman_login_otp',
    otpTemplateLang: process.env.OTP_TEMPLATE_LANG || 'en_US',
    // Deliver OTP via the approved AUTHENTICATION template. It reaches ANY user
    // (in or out of the 24h window) — required for new-user login — now that the
    // app is Live with billing configured. Set OTP_USE_TEMPLATE=0 to force text.
    otpUseTemplate: process.env.OTP_USE_TEMPLATE !== '0',
    // Structured templates keep each message's own layout, so their parameter
    // counts differ — they must never fall back to one another.
    briefingTemplate: process.env.BRIEFING_TEMPLATE_NAME || '',
    wrapTemplate: process.env.WRAP_TEMPLATE_NAME || '',
    // "Ready nudge" template WITH a quick-reply button. Sent to dormant users
    // (outside the 24h window) instead of the flattened content template: the
    // user taps the button, which OPENS the window, and the webhook then sends
    // the FULL rich free-form briefing/wrap (news + health + formatting). A
    // template variable cannot carry newlines, so this button hop is the only
    // way a dormant user receives the complete version. Empty → old behavior.
    briefingReadyTemplate: process.env.BRIEFING_READY_TEMPLATE_NAME || '',
    // The wrap can use its OWN ready-nudge template (or none). Meta judges each
    // template's category separately — a bare "your X is ready, tap to view"
    // nudge is often re-classified as MARKETING, while the data-rich structured
    // templates (BRIEFING_/WRAP_TEMPLATE_NAME) stay UTILITY. Leave a *_READY_*
    // name empty to skip the nudge and send the structured template directly
    // when the user is outside the 24h window. Unset → same as the briefing's.
    // Layout of BRIEFING_TEMPLATE_NAME's variables:
    //   'full'     → 6 vars (greeting, weather, schedule, email, tasks, closing)
    //   'reminder' → 3 vars (date, schedule, tasks due) — the UTILITY-safe
    //                "Your schedule for {{1}}: {{2}}. Tasks due today: {{3}}."
    //                Meta re-classifies daily digests (greeting/weather/closing)
    //                as MARKETING; a plain schedule reminder stays UTILITY.
    briefingTemplateStyle: (process.env.BRIEFING_TEMPLATE_STYLE || 'full').toLowerCase(),
    wrapReadyTemplate: process.env.WRAP_READY_TEMPLATE_NAME !== undefined
      ? process.env.WRAP_READY_TEMPLATE_NAME
      : (process.env.BRIEFING_READY_TEMPLATE_NAME || ''),
    proactiveTemplate: process.env.PROACTIVE_TEMPLATE_NAME || '',
    proactiveTemplateLang: process.env.PROACTIVE_TEMPLATE_LANG || 'en_US',
    proactiveUseTemplate: process.env.PROACTIVE_USE_TEMPLATE !== '0',
    get enabled() {
      return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    },
  },

  // Shopify OAuth app (Dev Dashboard). Merchants connect with one click;
  // Shopify hands back a per-store Admin API token we then store on the user.
  shopify: {
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    scopes: process.env.SHOPIFY_SCOPES || 'read_orders,read_products,read_customers',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
    get enabled() {
      return !!(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
    },
  },

  // Composio — the third-party integration bridge (Outlook/M365, Teams, Zoom,
  // Slack, HubSpot, Pipedrive, WooCommerce, Facebook Pages, Instagram, …).
  // Composio stores each user's OAuth tokens and runs the API calls, so we don't
  // build one client per app. Gmail/Google Calendar/Shopify/WhatsApp stay on our
  // own direct integrations — Composio is only for the NEW apps.
  //   COMPOSIO_API_KEY       project API key from the Composio dashboard.
  //   COMPOSIO_AUTH_CONFIGS  JSON map toolkit slug → auth config id, e.g.
  //                          {"outlook":"ac_123","slack":"ac_456"}. Only apps in
  //                          this map are offered to users. Use OUR OWN OAuth
  //                          app per auth config in production so the consent
  //                          screen says "Wingman", not "Composio".
  //   COMPOSIO_TOOLS         optional JSON map toolkit → [tool slugs] to expose.
  //                          Without it we expose Composio's "important" tools,
  //                          capped by COMPOSIO_TOOLS_PER_APP — every schema is
  //                          sent to Claude on every turn, so keep this tight.
  // With no key or no auth configs the feature is simply off.
  composio: {
    apiKey: process.env.COMPOSIO_API_KEY || '',
    authConfigs: parseJsonEnv('COMPOSIO_AUTH_CONFIGS', {}),
    tools: parseJsonEnv('COMPOSIO_TOOLS', {}),
    toolsPerApp: parseInt(process.env.COMPOSIO_TOOLS_PER_APP, 10) || 12,
    // Pending write actions expire if the user never says yes.
    approvalTtlMinutes: parseInt(process.env.COMPOSIO_APPROVAL_TTL_MINUTES, 10) || 30,
    get enabled() {
      return !!(process.env.COMPOSIO_API_KEY && Object.keys(this.authConfigs).length);
    },
  },

  // Meeting-notes email look: 'light' (default — follows the reader's own
  // light/dark setting; Gmail's app dark mode inverts it into a dark version)
  // or 'dark' (forced dark — Gmail's app inverts THAT back to light, so avoid).
  meetingEmail: {
    theme: (process.env.MEETING_EMAIL_THEME || 'light').toLowerCase(),
  },

  // NOW HRMS — Aamir's company attendance system. First-class connector: the
  // endpoint URL + one shared secret live HERE (company-wide, set once), so an
  // employee connects by just entering their company email — no URL/secret/code
  // per person. The same secret authenticates BOTH directions:
  //   Wingman → NOW HRMS  (clock the user)  : sent as X-Wingman-Secret
  //   NOW HRMS → Wingman  (user clocked)    : checked on /work/company-event
  nowhrms: {
    clockUrl: process.env.NOWHRMS_CLOCK_URL || 'https://nowhrms.com/api/wingman/clock',
    // Read snapshot endpoint (Phase 2). Defaults to the clock URL's sibling so a
    // single NOWHRMS_CLOCK_URL override still points both at the same server.
    dataUrl:
      process.env.NOWHRMS_DATA_URL ||
      (process.env.NOWHRMS_CLOCK_URL || 'https://nowhrms.com/api/wingman/clock').replace(/\/clock$/, '/employee-data'),
    // Manager team snapshot endpoint (Phase 4b) — sibling of the clock URL.
    teamUrl:
      process.env.NOWHRMS_TEAM_URL ||
      (process.env.NOWHRMS_CLOCK_URL || 'https://nowhrms.com/api/wingman/clock').replace(/\/clock$/, '/team-snapshot'),
    sharedSecret: process.env.NOWHRMS_SHARED_SECRET || '',
    // Only offer the one-tap connector when the server actually has the secret.
    get enabled() { return !!process.env.NOWHRMS_SHARED_SECRET; },
  },

  // Voice: OpenAI Whisper (speech->text) and TTS (text->speech).
  voice: {
    apiKey: process.env.OPENAI_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    // Latin script keeps Roman Urdu as Roman Urdu (see transcribe()).
    sttLanguage: process.env.VOICE_STT_LANGUAGE || 'en',
    ttsModel: process.env.VOICE_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'nova',
    get enabled() { return !!process.env.OPENAI_API_KEY; },
  },

  // ElevenLabs — Wingman's voice.
  //   - Voice notes: the briefing/wrap read aloud (TTS) and sent on WhatsApp
  //     next to the text, for users who turned on briefing calls.
  //   - Briefing calls: at the user's briefing/wrap time an ElevenLabs agent
  //     calls them ON WHATSAPP, talks them through it and answers questions
  //     (it asks Wingman through /voice/tools/ask). Missed call → text + voice note.
  //   WhatsApp only allows business-initiated calls from NON-US/Canada business
  //   numbers with a 2,000+/day messaging limit, and each user must grant call
  //   permission once (via ELEVENLABS_CALL_PERMISSION_TEMPLATE). Calls stay off
  //   until ELEVENLABS_CALLS=1.
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io',
    // "George" — warm British male, the closest stock voice to a JARVIS feel.
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
    ttsModel: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
    sttModel: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
    agentId: process.env.ELEVENLABS_AGENT_ID || '',
    callsEnabled: process.env.ELEVENLABS_CALLS === '1',
    // The WhatsApp number calls are placed from (must be non-US/Canada).
    // Defaults to Wingman's messaging number.
    callPhoneNumberId: process.env.ELEVENLABS_CALL_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    callPermissionTemplate: process.env.ELEVENLABS_CALL_PERMISSION_TEMPLATE || 'wingman_call_permission',
    callPermissionTemplateLang: process.env.ELEVENLABS_CALL_PERMISSION_TEMPLATE_LANG || 'en_US',
    // How long to wait for a call's outcome before falling back to text + voice.
    callTimeoutMinutes: parseInt(process.env.ELEVENLABS_CALL_TIMEOUT_MINUTES, 10) || 40,
    get enabled() { return !!process.env.ELEVENLABS_API_KEY; },
    get callsReady() {
      return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID && process.env.ELEVENLABS_CALLS === '1');
    },
  },

  // Gemini (Google): multimodal audio → text. Handles mixed Roman Urdu + English
  // well, so it's the primary meeting transcriber (Whisper stays as a fallback).
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '',
    // Use the *-latest alias, NOT a pinned version: Google RETIRED gemini-2.5-flash
    // (404 "no longer available"), and a pinned name then dies with it. The alias
    // tracks the current flash, and geminiTranscribe sets thinkingBudget:0 so the
    // old "alias moved to a thinking model → empty transcript" problem can't recur.
    // geminiTranscribe ALSO self-heals: on a 404 it falls through known-good models
    // (see MODEL_FALLBACKS), so even a stale GEMINI_MODEL in .env keeps working.
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    get enabled() { return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY); },
  },

  maps: {
    apiKey: process.env.MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '',
    get enabled() { return !!(process.env.MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY); },
  },

  // App study — Wingman reads each connected app (read-only) and keeps its own
  // summary so it understands the user's world. Each pass is a handful of model
  // calls per app; APP_STUDY=0 turns it off entirely.
  study: {
    enabled: process.env.APP_STUDY !== '0',
  },

  // Higgsfield — AI image generation ("make me a poster", images for posts).
  // HIGGSFIELD_API_KEY is "KEY_ID:KEY_SECRET" exactly as the Higgsfield console
  // shows it. Without it the image tools simply aren't offered.
  higgsfield: {
    apiKey: process.env.HIGGSFIELD_API_KEY || '',
    baseUrl: (process.env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, ''),
    // Model path as listed in the Higgsfield console; swap it without a deploy.
    imageModel: (process.env.HIGGSFIELD_IMAGE_MODEL || 'higgsfield-ai/soul/v2/standard').replace(/^\/+/, ''),
    resolution: process.env.HIGGSFIELD_IMAGE_RESOLUTION || '',   // '' = model default
    // Per-user cap so one chat can't burn the credit balance.
    dailyLimit: parseInt(process.env.IMAGE_DAILY_LIMIT, 10) || 20,
    get enabled() { return /^[^:\s]+:[^:\s]+$/.test(process.env.HIGGSFIELD_API_KEY || ''); },
  },

  // Images Wingman made or the user sent, kept on the data volume and served at
  // /media/<id>.jpg — a public (unguessable) URL is what Facebook/Instagram need
  // to fetch a photo for a post.
  media: {
    dir: path.resolve(__dirname, '..', process.env.MEDIA_DIR || path.join(path.dirname(process.env.DATABASE_PATH || './data/wingman.db'), 'media')),
    keepDays: parseInt(process.env.MEDIA_KEEP_DAYS, 10) || 60,
  },

  // Brevo transactional email API, used for sending business-mailbox replies
  // because Railway blocks outbound SMTP. Reading still uses IMAP directly.
  brevo: {
    apiKey: process.env.BREVO_API_KEY || '',
    get enabled() { return !!process.env.BREVO_API_KEY; },
  },

  // Landing-page waitlist → live Google Sheet.
  //   The boss wants a Google Sheet that updates itself as signups arrive. We do
  //   that by POSTing each signup to a Google Apps Script "Web App" bound to the
  //   sheet (it appends/updates a row). This needs NO Google service account or
  //   key on our side — just the deployed Web App URL. The shared secret is an
  //   optional token the Apps Script checks so only we can write to the sheet.
  //   Leave sheetWebhookUrl empty and this feature is simply off (signups still
  //   land in the DB + team email exactly as before).
  waitlist: {
    sheetWebhookUrl: process.env.WAITLIST_SHEET_WEBHOOK_URL || '',
    sheetSecret: process.env.WAITLIST_SHEET_SECRET || '',
    get sheetEnabled() { return !!process.env.WAITLIST_SHEET_WEBHOOK_URL; },

    // Team alert on every signup (existing behaviour, now configurable).
    notifyFrom: process.env.WAITLIST_FROM || 'hello@wehearyou.studio',

    // Thank-you email to the person who just joined (thank-you-v1 design,
    // src/templates/email/waitlist-thank-you.html). Sent via Brevo, once per
    // email address, only on a NEW signup. On by default whenever Brevo is
    // configured; WAITLIST_THANKYOU=0 switches it off without a code change.
    //   From: the template tells people to add hello@imyourwingman.ai to their
    //   contacts, so we send FROM that address. The imyourwingman.ai domain MUST
    //   be authenticated in Brevo (Senders & Domains → SPF + DKIM + DMARC) or
    //   Brevo rejects/spam-folders it. Replies go to the same inbox.
    //   Images: served by this container at /email/v1/ (src/assets/email/v1),
    //   on the app domain — no third-party host, no bot challenge.
    //   Unsubscribe links are HMAC-signed with SECRET_KEY so nobody can
    //   unsubscribe someone else by guessing the URL.
    thankYou: {
      from: process.env.WAITLIST_THANKYOU_FROM || 'hello@imyourwingman.ai',
      fromName: process.env.WAITLIST_THANKYOU_FROM_NAME || 'Wingman',
      subject: process.env.WAITLIST_THANKYOU_SUBJECT || "You're on the list",
      // Public origin of THIS server for images + unsubscribe links. The root
      // domain only proxies /api/* to us, so use the app subdomain.
      publicUrl: (process.env.WAITLIST_EMAIL_PUBLIC_URL || 'https://app.imyourwingman.ai').replace(/\/+$/, ''),
      signingSecret: process.env.SECRET_KEY || process.env.SESSION_SECRET || '',
      get enabled() {
        return process.env.WAITLIST_THANKYOU !== '0' && !!process.env.BREVO_API_KEY;
      },
    },
  },

  weather: {
    apiKey: process.env.WEATHER_API_KEY || '',
    defaultCity: process.env.WEATHER_DEFAULT_CITY || 'Dubai',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      'http://localhost:3000/auth/google/callback',
  },

  whatsapp: {
    sessionPath: path.resolve(
      __dirname,
      '..',
      process.env.WHATSAPP_SESSION_PATH || './.wwebjs_auth'
    ),
  },
};

module.exports = config;
