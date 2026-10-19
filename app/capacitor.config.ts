import type { CapacitorConfig } from '@capacitor/cli'

// Wingman as a native iOS + Android app. The SAME web app (this folder) runs
// inside the native shell; `npm run build` → `npx cap sync` copies dist/ in.
// It talks to the live backend (https://imyourwingman.ai) like the PWA does.
const config: CapacitorConfig = {
  appId: 'ai.imyourwingman.app',
  appName: 'Wingman',
  webDir: 'dist',
  // https:// origin on Android (cookies/storage behave like a normal site).
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never' },
  plugins: {
    // CENTER_CROP: the default FIT_XY stretched the logo on tall phones.
    SplashScreen: { launchAutoHide: false, backgroundColor: '#ffffff', showSpinner: false, androidScaleType: 'CENTER_CROP' },
  },
}

export default config
