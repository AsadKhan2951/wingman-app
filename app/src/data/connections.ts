import { useSyncExternalStore } from 'react'
import { connectors as seed, type Connector, type ConnectorStatus } from './mock'
import { api } from './api'
import { DEMO } from './demo'
import { getSession } from './session'

type Overrides = Record<string, boolean>

const KEY = 'wingman.connections'

const read = (): Overrides => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

let current: Overrides = read()
const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

const write = (next: Overrides) => {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
  }
  listeners.forEach((fn) => fn())
}

const statusOf = (o: Overrides, c: Connector): ConnectorStatus => {
  if (c.status === 'soon') return 'soon'
  // Outside demo mode nothing shows connected until the backend says so
  // (WhatsApp counts as connected once the user is signed in).
  const on = o[c.key] ?? (DEMO ? c.status === 'connected' : c.key === 'whatsapp' && getSession().signedIn)
  return on ? 'connected' : 'connect'
}

export const connect = (key: string) => write({ ...current, [key]: true })
export const disconnect = (key: string) => write({ ...current, [key]: false })
/** Forget everything (sign-out / a different user on this device). */
export const resetConnections = () => write({})

export type ConnectionView = {
  items: Connector[]
  connected: number
  linkable: number
  webmail: boolean
}

const project = (o: Overrides): ConnectionView => {
  const items = seed.map((c) => ({ ...c, status: statusOf(o, c) }))
  return {
    items,
    connected: items.filter((c) => c.status === 'connected').length,
    linkable: items.filter((c) => c.status === 'connect').length,
    // Business mailbox isn't a seed connector, so surface it as a flag.
    webmail: !!o.webmail,
  }
}

let view = project(current)
let seen = current
const snapshot = () => {
  if (seen !== current) {
    view = project(current)
    seen = current
  }
  return view
}

export const useConnections = () => useSyncExternalStore(subscribe, snapshot)

/**
 * Reflect the REAL connection state from the backend (/api/me): Gmail, Google
 * Calendar and Health. These override the seed's optimistic "connected", so a
 * connector only shows connected when the OAuth actually happened. Best-effort.
 */
export const hydrateConnections = async (): Promise<void> => {
  try {
    const me = (await api.me()) as Record<string, unknown>
    write({
      ...current,
      gmail: !!me.gmail_connected,
      gcal: !!me.calendar_connected,
      health: !!me.health_connected,
      webmail: !!me.webmail_connected,
      shopify: !!me.shopify_connected,
      ga: false,
    })
  } catch {
    /* keep what we have */
  }
}
