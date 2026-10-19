import { useSyncExternalStore } from 'react'
import { NOW, TODAY, calendarDays as mockDays, type CalEvent, type ChipTone } from './mock'
import { DEMO } from './demo'

const calendarDays: typeof mockDays = DEMO ? mockDays : {}
import { api } from './api'
import { plural, t } from '../i18n'

const MS_DAY = 86_400_000

const parse = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

const format = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}


export const addDays = (iso: string, n: number) => format(parse(iso) + n * MS_DAY)

export const addMonths = (iso: string, n: number) => {
  const d = new Date(parse(iso))
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + n
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return format(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)))
}

export const startOfWeek = (iso: string) => addDays(iso, -weekdayIndex(iso))

export const weekOf = (iso: string) => {
  const start = startOfWeek(iso)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

export const monthGrid = (iso: string) => {
  const d = new Date(parse(iso))
  const first = format(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const start = startOfWeek(first)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}


export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const weekdayIndex = (iso: string) => (new Date(parse(iso)).getUTCDay() + 6) % 7

export const dayNumber = (iso: string) => new Date(parse(iso)).getUTCDate()

export const initialOf = (dayShort: string) => {
  const answer = t(dayShort, undefined, 'initial')
  return answer === dayShort ? dayShort[0] : answer
}

export const weekdayInitial = (iso: string) => initialOf(WEEKDAYS_SHORT[weekdayIndex(iso)])

export const monthLabel = (iso: string) => t(MONTHS[new Date(parse(iso)).getUTCMonth()])
export const yearLabel = (iso: string) => String(new Date(parse(iso)).getUTCFullYear())

export const inSameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7)

export const isToday = (iso: string) => iso === TODAY

export const dayLabel = (iso: string) => {
  if (iso === TODAY) return t('Today')
  if (iso === addDays(TODAY, 1)) return t('Tomorrow')
  if (iso === addDays(TODAY, -1)) return t('Yesterday')
  return t('{weekday} {day} {month}', {
    weekday: t(WEEKDAYS_SHORT[weekdayIndex(iso)]),
    day: dayNumber(iso),
    month: t(MONTHS_SHORT[new Date(parse(iso)).getUTCMonth()]),
  })
}


export const eventsFor = (iso: string): CalEvent[] => {
  // Once the real calendar has loaded, days with no real event are truly empty
  // (no mock fill-in). Before that, the seed keeps the UI from flashing blank.
  const src = realDays ? realDays[iso] ?? [] : calendarDays[iso]?.events ?? []
  return [...src].sort((a, b) => a.time.localeCompare(b.time))
}

export const briefFor = (iso: string) => (realDays ? undefined : calendarDays[iso]?.brief)

export const dotsFor = (iso: string) => Math.min(3, eventsFor(iso).length)

export type AgendaEvent = CalEvent & { state?: 'past' | 'next' }

export const agendaFor = (iso: string): { events: AgendaEvent[]; nowAt: number } => {
  const list = eventsFor(iso)

  if (iso < TODAY) return { events: list.map((e) => ({ ...e, state: 'past' })), nowAt: -1 }
  if (iso > TODAY) return { events: list, nowAt: -1 }

  const upcoming = list.findIndex((e) => e.time >= NOW)
  return {
    events: list.map((e, i) => ({
      ...e,
      state: e.time < NOW ? 'past' : i === upcoming ? 'next' : undefined,
    })),
    nowAt: list.length === 0 ? -1 : upcoming === -1 ? list.length : upcoming,
  }
}

export const summaryFor = (iso: string) => {
  const list = eventsFor(iso)
  const events = (n: number) => plural(n, { one: '{n} event', other: '{n} events' })
  if (list.length === 0) return t('Nothing scheduled')
  if (iso !== TODAY) return events(list.length)

  const done = list.filter((e) => e.time < NOW).length
  const ahead = list.length - done
  if (done === 0) return t('{events} ahead', { events: events(ahead) })
  if (ahead === 0) return t('All done')
  return t('{done} done · {ahead} ahead', { done, ahead })
}

export const emptyLineFor = (iso: string) =>
  iso < TODAY
    ? { title: t('Nothing was on'), body: t('A clear day. Nothing needed you.') }
    : { title: t('Nothing on yet'), body: t("I'll keep it clear unless something lands that needs you.") }

export const peekFor = (iso: string) => {
  for (let i = 1; i <= 60; i++) {
    const date = addDays(iso, i)
    const list = eventsFor(date)
    if (list.length > 0) {
      return {
        date,
        title: dayLabel(date),
        sub: t('{events} · first at {time}', {
          events: plural(list.length, { one: '{n} event', other: '{n} events' }),
          time: list[0].time,
        }),
      }
    }
  }
  return null
}

// ── Real calendar (Google, via /api/calendar) ───────────────────────────────
// The whole calendar (grid dots, agenda, day briefs, peek) flows through
// eventsFor/briefFor above, so wiring just those two makes every screen real.
// realDays stays null until the first load so the seed shows meanwhile.

type ServerEvent = {
  id?: string
  gcal_event_id?: string | null
  title?: string
  location?: string | null
  start_time?: string
  end_time?: string
  attendees?: unknown[]
  has_conflict?: boolean
  meeting_url?: string | null
  meeting_provider?: string | null
}

let realDays: Record<string, CalEvent[]> | null = null
let calVersion = 0
const calListeners = new Set<() => void>()
const subscribeCal = (fn: () => void) => {
  calListeners.add(fn)
  return () => void calListeners.delete(fn)
}
// Screens that read the calendar call this so they re-render when it loads.
export const useCalendarData = () => useSyncExternalStore(subscribeCal, () => calVersion)

// Read the date + time EXACTLY as written in the event's RFC3339 string, i.e.
// in the event's own calendar timezone — the same wall-clock the user sees in
// Google Calendar. This is deliberately NOT converted to the device's timezone:
// `new Date(str).getHours()` would shift a "10:45 PM" event to whatever the
// phone's clock says, which is what made the app show wrong times. All-day
// events are date-only (no time part) → `time` comes back ''.
const RFC = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/
const wallParts = (iso: string): { date: string; time: string } | null => {
  const m = RFC.exec(iso || '')
  if (!m) return null
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] != null ? `${m[4]}:${m[5]}` : '' }
}

const durLabel = (start: Date, end?: Date): string => {
  if (!end || Number.isNaN(end.getTime())) return ''
  const mins = Math.round((end.getTime() - start.getTime()) / 60000)
  if (mins <= 0) return ''
  if (mins < 60) return `${mins} min`
  const hrs = mins / 60
  return Number.isInteger(hrs) ? `${hrs} hr` : `${hrs.toFixed(1)} hr`
}

const TONES: ChipTone[] = ['blue', 'lavender', 'mint', 'peach', 'sand', 'rose']

const toEvent = (e: ServerEvent, i: number): CalEvent | null => {
  if (!e.start_time) return null
  const wall = wallParts(e.start_time)
  if (!wall) return null
  // Duration is an absolute delta (end − start), so it's timezone-independent —
  // safe to compute from parsed Dates even though we display wall-clock times.
  const start = new Date(e.start_time)
  const end = e.end_time ? new Date(e.end_time) : undefined
  const guests = Array.isArray(e.attendees) ? e.attendees.length : 0
  return {
    time: wall.time,
    dur: Number.isNaN(start.getTime()) ? '' : durLabel(start, end),
    title: e.title || t('Untitled'),
    sub: e.location || (guests ? plural(guests, { one: '{n} guest', other: '{n} guests' }) : ''),
    tone: TONES[i % TONES.length],
    icon: 'calendar',
    ...(e.location ? { place: e.location } : {}),
    ...(e.has_conflict ? { flag: t('Conflict') } : {}),
    ...(e.meeting_url ? { meetingUrl: e.meeting_url } : {}),
    ...(e.meeting_provider ? { meetingProvider: e.meeting_provider } : {}),
    ...(e.gcal_event_id ? { gcalEventId: e.gcal_event_id } : {}),
  }
}

/** Load the user's real Google calendar. Best-effort — keeps the seed on error. */
export const hydrateCalendar = async (): Promise<void> => {
  try {
    const res = await api.calendar()
    const map: Record<string, CalEvent[]> = {}
    ;((res.events as ServerEvent[]) || []).forEach((e, i) => {
      const ev = toEvent(e, i)
      if (!ev || !e.start_time) return
      // Group by the event's OWN calendar day (wall-clock), not the device's —
      // so a late-night event doesn't slide onto the wrong day on a phone in a
      // different timezone.
      const key = wallParts(e.start_time)?.date
      if (!key) return
      ;(map[key] ||= []).push(ev)
    })
    realDays = map
    calVersion++
    calListeners.forEach((fn) => fn())
  } catch {
    /* keep the seed */
  }
}
