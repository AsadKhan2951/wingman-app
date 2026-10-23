import { useSyncExternalStore } from 'react'
import { email as seed, type EmailItem } from './mock'
import { api } from './api'
import { DEMO } from './demo'

// The Email screen reads { needsReply, handled, handledToday }. We load the real
// triaged mail from the backend and map it onto that shape, falling back to the
// seed until it arrives. The screen's own gate (gmail connection) is real too.
export type EmailView = { handledToday: number; needsReply: EmailItem[]; handled: EmailItem[] }

const seedView: EmailView = DEMO ? (seed as unknown as EmailView) : { handledToday: 0, needsReply: [], handled: [] }

let server: EmailView | null = null
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

type ServerEmail = {
  id?: string
  sender?: string
  subject?: string
  category?: string
  summary?: string
  replied?: boolean | number
  source?: 'gmail' | 'webmail'
  avatar?: string | null
  created_at?: string
  received_at?: string | null
  detected_type?: string
}

const TONES = ['blue', 'lavender', 'mint', 'peach', 'sand', 'rose'] as const

// Stable colour per sender (like Gmail): the same person always gets the same
// tone, instead of cycling by row position.
const toneFor = (name: string): (typeof TONES)[number] => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return TONES[h % TONES.length]
}

const nameOf = (sender?: string): string => {
  if (!sender) return 'Unknown'
  const m = sender.match(/^\s*"?([^"<]+?)"?\s*(?:<|$)/)
  return ((m ? m[1] : sender).trim() || sender).slice(0, 40)
}

// When the email ARRIVED, Gmail-style: "3:40 PM" today, "Yesterday", a weekday
// this week, else "12 Oct".
const timeOf = (iso?: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= startToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (t >= startToday - 86400000) return 'Yesterday'
  if (t >= startToday - 6 * 86400000) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

const isReplied = (e: ServerEmail) => e.replied === true || e.replied === 1

const toItem = (e: ServerEmail): EmailItem => {
  const from = nameOf(e.sender)
  return {
    id: e.id,
    from,
    initial: from.charAt(0).toUpperCase(),
    person: true,
    tone: toneFor(from),
    subject: e.subject || '(no subject)',
    preview: e.summary || '',
    time: timeOf(e.received_at || e.created_at),
    unread: !isReplied(e),
    source: e.source === 'webmail' ? 'webmail' : 'gmail',
    avatar: e.avatar || null,
  }
}

const project = (list: ServerEmail[]): EmailView => {
  const needs = list.filter((e) => (e.category === 'needs_reply' || e.category === 'urgent') && !isReplied(e))
  const needsSet = new Set(needs)
  const handled = list.filter((e) => !needsSet.has(e))
  return {
    handledToday: list.filter(isReplied).length,
    needsReply: needs.map(toItem),
    handled: handled.map(toItem),
  }
}

// server / seedView are both stable references, so getSnapshot never loops.
const snapshot = (): EmailView => server ?? seedView
export const useEmails = () => useSyncExternalStore(subscribe, snapshot)

/** Load the user's real triaged mail. Best-effort — keeps the seed on error. */
export const hydrateEmails = async (): Promise<void> => {
  try {
    const res = await api.emails()
    server = project((res.emails as ServerEmail[]) || [])
    listeners.forEach((fn) => fn())
  } catch {
    /* keep the seed */
  }
}
