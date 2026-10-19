import { useSyncExternalStore } from 'react'
import { isSignedIn, setToken } from './api'

export type Session = { onboarded: boolean; signedIn: boolean }

const KEY = 'wingman.session'

const FRESH: Session = { onboarded: false, signedIn: false }

const read = (): Session => {
  try {
    const raw = localStorage.getItem(KEY)
    const s = raw ? { ...FRESH, ...(JSON.parse(raw) as Partial<Session>) } : FRESH
    // A stored auth token means we're signed in, even on a fresh load.
    return { ...s, signedIn: s.signedIn || isSignedIn() }
  } catch {
    return FRESH
  }
}

let current: Session = read()
const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

const write = (patch: Partial<Session>) => {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
  }
  listeners.forEach((fn) => fn())
}

export const useSession = () => useSyncExternalStore(subscribe, () => current)

export const getSession = () => current

export const completeOnboarding = () => write({ onboarded: true, signedIn: true })

// Mark onboarded WITHOUT forcing signedIn (used when the backend says a
// returning user already finished onboarding, so they skip the wizard).
export const markOnboarded = () => write({ onboarded: true })

export const signIn = () => write({ signedIn: true })

// The next person on this device must not inherit the last one's connectors.
const forgetConnections = () => {
  try {
    localStorage.removeItem('wingman.connections')
  } catch {
    /* ignore */
  }
  void import('./connections').then((m) => m.resetConnections())
}

export const signOut = () => {
  setToken(null)
  forgetConnections()
  write({ signedIn: false })
}

export const startFresh = () => {
  forgetConnections()
  write({ onboarded: false, signedIn: false })
}
