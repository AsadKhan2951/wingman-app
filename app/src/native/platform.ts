// Native (iOS / Android via Capacitor) vs browser. Everything native-only
// lives here so the rest of the app stays one codebase.
import { Capacitor } from '@capacitor/core'

export const isNative = (): boolean => Capacitor.isNativePlatform()
export const platform = (): 'ios' | 'android' | 'web' => Capacitor.getPlatform() as 'ios' | 'android' | 'web'

// Custom URL scheme the backend sends Google / Apple sign-ins back to.
// Must match APP_URL_SCHEME on the server and the native projects.
export const APP_SCHEME = 'ai.imyourwingman.app'

/** Open a link outside the app: in-app browser sheet on native, new tab on web. */
export const openExternal = (url: string) => {
  if (isNative()) {
    // mailto:/tel:/wa.me must go to the OS, not the in-app browser.
    if (/^(mailto:|tel:|sms:|https?:\/\/(wa\.me|api\.whatsapp\.com)\/)/i.test(url)) {
      window.location.href = url
      return
    }
    void import('@capacitor/browser').then(({ Browser }) => Browser.open({ url, presentationStyle: 'popover' }))
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Wire up the native shell: deep links, status bar, splash, Android back. */
export const initNative = async () => {
  if (!isNative()) return
  document.documentElement.classList.add('is-native', `is-${platform()}`)
  const [{ App }, { SplashScreen }, { StatusBar, Style }] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/splash-screen'),
    import('@capacitor/status-bar'),
  ])

  // ai.imyourwingman.app://auth-callback?code=…  → the app's own route.
  void App.addListener('appUrlOpen', ({ url }) => {
    const m = url.match(/^[a-z.]+:\/\/(.*)$/i)
    if (!m) return
    window.location.hash = `#/${m[1].replace(/^\/+/, '')}`
    void import('@capacitor/browser').then(({ Browser }) => Browser.close()).catch(() => {})
  })

  // Android hardware back: go back in the app, exit at the root.
  void App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && window.location.hash && window.location.hash !== '#/' && window.location.hash !== '#/home') {
      window.history.back()
    } else {
      void App.exitApp()
    }
  })

  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  try {
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    if (platform() === 'android') await StatusBar.setOverlaysWebView({ overlay: true })
  } catch {
    /* not available */
  }
  // Hide the native splash once the web app has painted.
  window.setTimeout(() => void SplashScreen.hide(), 300)
}
