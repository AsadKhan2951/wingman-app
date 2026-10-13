# Wingman — iOS & Android app (Capacitor)

The native apps are the **same web app** (`app/`) running inside a native shell
(Capacitor 8). One codebase: a change here ships to web, iOS and Android.

```
app/
  src/            the app (React)            ← edit here
  src/native/     native-only glue (deep links, status bar, external links)
  capacitor.config.ts   appId ai.imyourwingman.app, name "Wingman"
  ios/            Xcode project   (generated, committed)
  android/        Android Studio project (generated, committed)
  assets/         source icon + splash  (npx @capacitor/assets generate)
```

The app talks to the live backend `https://imyourwingman.ai` — nothing else to run.

## One-time Mac setup
1. **Xcode** from the App Store → open it once, accept the licence, let it
   install the iOS platform. Then in Terminal: `xcode-select --install`.
2. **Node 22**: `brew install node@22` (or nvm). Check: `node -v` → v22.x.
3. **Android Studio** (only for Android) → open once, finish the setup wizard.
4. Clone: `git clone https://github.com/AsadKhan2951/wingman-app.git` and
   `cd wingman-app/app && npm install`.

## Run
- iOS: `npm run ios` → builds the web app, copies it in, opens Xcode.
  In Xcode: **App** target → *Signing & Capabilities* → pick your **Team**
  (your Apple ID works for testing on your own iPhone) → choose a simulator or
  your iPhone at the top → **▶ Run**.
- Android: `npm run android` → opens Android Studio → **▶ Run**.

After changing app code: `npm run cap:sync` (or just `npm run ios` again).

## How sign-in with Google/Apple works in the app
Google blocks sign-in inside app web views, so the app opens the system
browser at `/api/auth/<provider>/start?app=1`; the server sends the result back
to `ai.imyourwingman.app://auth-callback?code=…`, which the app catches
(`src/native/platform.ts`, Info.plist `CFBundleURLTypes`, AndroidManifest
intent-filter). The scheme must match `APP_URL_SCHEME` on the server.

## Icons / splash
Edit `assets/icon-only.png` (1024², no transparency) and `assets/splash*.png`,
then `npx @capacitor/assets generate --ios --android`.
