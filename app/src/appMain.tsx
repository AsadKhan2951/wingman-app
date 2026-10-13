import React from 'react'
import type { Root } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './pwa/registerSW'
import { initIosKeyboardFix } from './pwa/iosKeyboardFix'
import { initKeyboardInset } from './shell/keyboard'
import { loadPrefs } from './shell/prefs'
import { applyLanguage } from './i18n'
import { initNative, isNative } from './native/platform'

export const mountApp = (root: Root) => {
  // The native app ships its files inside the app — no service worker there.
  if (!isNative()) registerServiceWorker()
  void initNative()
  initIosKeyboardFix()
  initKeyboardInset()
  loadPrefs()
  applyLanguage()

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
