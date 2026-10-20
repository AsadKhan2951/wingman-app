# Wingman — Full Audit (2026-10-18)

Five read-only audit agents (security, LLM engine, messaging/schedulers/DB,
frontend/mobile, devops/deps) plus a hands-on run. Every finding cites code the
agents read; the two Critical items and the gate bypass were re-checked by hand.

## Run results

| Check | Result |
| --- | --- |
| `app/` web build (`tsc && vite build`) | ✅ passes (main chunk 1 MB — code-split later) |
| Android debug APK (`gradlew assembleDebug`) | ✅ 6.1 MB, installs and runs on emulator (API 37): onboarding → "Create your account" |
| Backend boot (`DISABLE_WHATSAPP=1`, temp DB) | ✅ `/health` ok, schema init, schedulers registered, UI served from `app/dist` |
| Offline tests: whatsapp-window, engine-offline, briefing-call, voice-chat, accounts | ✅ all 5 pass (103 checks) |
| `npm audit --omit=dev` (backend) | ⚠️ 1 high (`@xmldom/xmldom` ≤0.8.14, transitive), 3 moderate |
| `npm audit --omit=dev` (app) | ✅ 0 |

Not tested: sign-in end-to-end (it targets the production backend and the emulator had no network), iOS build, live model eval.

---

## 🔴 Critical — fix first

1. **Account takeover via last-10-digit phone match.** `src/db/users.js:16-49`: `getByPhone` falls back to matching the last 10 digits across all users. A number in another country with the same last 10 digits (e.g. `44 300…` vs `92 300…`) gets an OTP on the attacker's phone and a session for the victim. WhatsApp messages from that number also drive the victim's assistant. **Fix:** key on full E.164; use the last-10 fallback only for legacy 10-digit rows, never across differing country codes.
2. **"Sign in by reply" confirms the newest code, not the referenced one.** `src/db/auth.js:60-74` (`confirmByRef`), `server.js:541-566`. An attacker requests an OTP for the victim and gets the victim to send any `WM-XXXXXX` text, or races the victim's own request. The attacker then polls `/otp-status` and receives the victim's session. **Fix:** confirm only `ref = ? AND phone AND purpose='login'`.

## 🟠 High

**Security**
3. **The approval gate is off when Composio is off.** `integrationExecutor.js:270-274` (verified): `send_email`, `delete_event` and the other built-in sends run immediately in chat if `COMPOSIO_API_KEY` is unset.
4. **Specialist agents bypass the gate.** `agentExecutor.js:31-95` calls the Gmail/Calendar executors directly, so the Ops specialist can `send_email`/`delete_event` with no yes. This also happens in automated runs.
5. **Prompt-injection exfiltration.** `browse_page`, `create_event` with external attendees and `create_automation` are ungated, including in automated runs (`conversation.js:371-420`).
6. **SSRF in `browse_page`.** `services/browser.js:33-47`: no private-IP check (cloud metadata, `127.0.0.1:3000`), and Chromium runs `--no-sandbox` as root.
7. **Vault credentials are matched to sites by substring.** `browser.js:88-117`: credentials for `bank.com` auto-fill on `bank.com.evil.io`.
8. **Webhook HMAC fails open** when `WHATSAPP_APP_SECRET` is unset (`server.js:630`). Forged messages also count as the user's "yes".
9. **An unfinished Google/Apple signup can be taken over by password signup** (`accountRoutes.js:111-120`).
10. **The OTP is exposed in API responses unless `NODE_ENV=production`.** `.env.example` sets `development`.
11. **Native OAuth.** The custom-scheme callback can be hijacked by another app (no PKCE). Login CSRF works via `#/auth-callback?code=` (no nonce). See `app/src/native/platform.ts`, `Auth.tsx:365`.
12. **Token storage.** The token and all cached data sit in WebView `localStorage`, with Android `allowBackup="true"`. **Sign-out** doesn't call `api.logout()` and leaves user data on the device (`SignIn.tsx:19`, `session.ts:50`).

**Reliability**
13. **Held messages are deleted before sending** (`client.js:238-306`). A failed send loses them permanently.
14. **Briefings fire only in an exact 15-minute window, and overlapping ticks are skipped** (`time.js:133`, `scheduler.js:25`). A slow tick or a deploy means users miss that day's briefing. Use "due and not sent today, within a grace period".
15. **Email scans can run twice at once** (cron plus preBriefing, no lock). This produces duplicate bills and alerts (`emailScanner.js:136-170`).
16. **No per-user turn serialization** (`conversation.js:65`, `server.js:645`). Parallel turns duplicate actions, and message B arriving mid-turn satisfies turn A's approval gate.

**DevOps**
17. **Node 20 is EOL.** The app runs fine on Node 24 locally. Bump the Dockerfile and `engines`.
18. **`.dockerignore` lets secrets and data into the image.** Only `.env` is excluded, so `.env.bak`, `google-state.json`, `data/` and `.claude/` are baked in by `COPY . .`.
19. **The container runs as root.**
20. **Five test scripts write to the real DB.** These are `test-engine`, `test-proactive`, `test-email`, `test-calendar` and `test-auth-db`.
21. **SQLite backups happen only on deploy, on the same droplet.** There is no off-site copy.

## 🟡 Medium (selected)

- An executor throw kills the whole turn: no try/catch around tool dispatch (`conversation.js:366-436`).
- `max_tokens` and `refusal` stop reasons are reported as "Done ✅" (`conversation.js:440`).
- History can start with an assistant row, which risks an API 400.
- Prompt caching misses the message history, and the voice/automation paths don't cache at all.
- Specific WhatsApp templates fall back to the generic one on any error. This breaks the CLAUDE.md rule and can double-send.
- A failed send still uses up its dedup slot. Text over 4096 characters is silently cut.
- There is no graceful shutdown. In-flight webhook messages are acked and marked seen, then lost on redeploy.
- Indexes are missing for `conversations(user_id, created_at)`. `LIKE` scans run on every proactive send.
- Tables never shrink: conversations, sessions, otp_codes, voice_calls. `userIndex` runs a `NOT IN` full scan every 15 minutes.
- A schema failure partway through skips the later tables (`db/index.js:30`).
- `mergeDuplicatePhones` hard-deletes rows every 15 minutes (`users.js:287`).
- The login rate limiter can be reset (`attempts.clear()` at 5000 keys). Password reset leaves old sessions alive.
- `notify-attendees` lets any user send WhatsApp messages to arbitrary numbers. Webmail connect lets them probe internal hosts.
- The service worker caches error pages and admin pages as `/index.html`, and serves everything cache-first.
- `href` values (meeting URLs from calendar invites) are not scheme-checked, so `javascript:` URLs work. There is no CSP.
- The app shows mock "demo" data when hydration fails. Tasks are keyed by title.
- Native location doesn't work: Android/iOS location permissions are missing.
- A build without `VITE_API_BASE` hits production. CORS is `*`.
- `process.env` is read in about 10 files outside `config.js`. `.env.example` is missing about 40 variables.
- `xlsx@0.18.5` is abandoned and vulnerable. whatsapp-web.js fetches HTML from GitHub `main` at runtime.
- `app/dist` is committed (stale-UI trap).

## 🟢 Low (selected)

- **Docs drift.** `GEMINI_MODEL` defaults to `gemini-flash-latest` (`config.js:303`), which contradicts CLAUDE.md. `DEPLOYMENT.md` and `railway.json` are stale.
- **Model IDs.** `claude-sonnet-5`, `claude-opus-5` and `claude-haiku-4-5` are valid, but Claude 5.5 is current and cheaper (Opus, Haiku).
- **Dead code.** `taskIntents.detect()` (regex intents), `taskExtractor.js`, and `runOnboarding` in `conversation.js`.
- **Android release setup.** `versionCode 1` with no release signing. **iOS:** `armv7` capability, no `PrivacyInfo.xcprivacy`.
- **Accessibility.** `maximum-scale=1` blocks zoom. `__seed.html` and `/foundations` ship to production.
- **Session tokens** are stored in plaintext. `cors()` is open. The admin key is accepted in a query string.
- **Repo clutter.** `mobile/` (superseded), `Claude outputs/`, `thank-you-v1/`, the docx/html files. `client/` is still built in every image.

## ✅ Checked and fine

- SQL is parameterized, and dynamic columns are allowlisted.
- No IDOR in `dashboard.js`.
- Passwords use scrypt with a timing-safe compare.
- Shopify HMAC is checked.
- The voice endpoints' secrets are checked in constant time.
- Webhook dedup is atomic.
- No secrets are tracked in git or in its history.
- TypeScript is strict, and the app has no `dangerouslySetInnerHTML`.
- `targetSdk 36`.
- No keyword shortcuts sit on the live message path.

## Suggested order

1. Critical items 1–2. Then gate fixes 3–5, then webhook fail-closed (8) and OTP exposure (10).
2. Held-message loss (13), briefing window (14), per-user queue (16), scan lock (15).
3. `.dockerignore`, run as non-root, Node 22/24 bump, off-site backups.
4. Mobile: PKCE + nonce, secure token storage, `allowBackup=false`, real logout.
