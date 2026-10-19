import { openExternal } from '../native/platform'
import { useEffect, useRef, useState } from 'react'
import type { IconName } from '../app/icons'
import { api, ApiError } from '../data/api'
import type { OtpRequest } from '../data/api'
import { signIn } from '../data/session'

export type Screen =
  | 'splash'
  | 'intro'
  | 'auth'
  | 'phone'
  | 'verify'
  | 'name'
  | 'tz'
  | 'rhythm'
  | 'proactivity'
  | 'skills'
  | 'personality'
  | 'interests'
  | 'places'
  | 'health'
  | 'business'
  | 'boundaries'
  | 'ready'

export const COUNTRY_CODES = ['+971', '+92', '+966', '+91', '+44', '+1', '+65']

export const CC_FLAGS: Record<string, string> = {
  '+971': '🇦🇪',
  '+92': '🇵🇰',
  '+966': '🇸🇦',
  '+91': '🇮🇳',
  '+44': '🇬🇧',
  '+1': '🇺🇸',
  '+65': '🇸🇬',
}

export const ZONES = [
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Riyadh',
  'Asia/Kolkata',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Singapore',
]

export const detectTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ZONES[0]
  } catch {
    return ZONES[0]
  }
}

export const PROACTIVITY = [
  { value: 'Low', blurbA: 'I stay quiet and only answer when you message me.', blurbB: 'I answer when you write. Nothing more.' },
  { value: 'Moderate', blurbA: 'Daily briefings, plus a heads-up when something is urgent.', blurbB: 'Daily briefings, and a word when something’s urgent.' },
  { value: 'High', blurbA: 'The full chief of staff - briefings, reminders, and nudges.', blurbB: 'The full chief of staff - briefings, reminders, nudges.' },
]

export const SKILLS = [
  { name: 'Travel Assistant', emoji: '✈️', blurb: 'Flight alerts, itineraries, arrival briefings' },
  { name: 'Bill Tracker', emoji: '🧾', blurb: 'Reminders before bills are due' },
  { name: 'Delivery Tracker', emoji: '📦', blurb: 'Package status and return windows' },
  { name: 'People CRM', emoji: '👥', blurb: 'Remembers who you talk to, and when' },
  { name: 'Follow-up Tracker', emoji: '🤝', blurb: 'Never drop a promise you made' },
]

export const TONES = [
  { value: 'Professional', blurb: 'Polished and precise.' },
  { value: 'Casual', blurb: 'Relaxed and conversational.' },
  { value: 'Friendly', blurb: 'Warm, efficient, slightly witty.' },
]


export const INTERESTS: { key: string; name: string; icon: IconName; tone: string }[] = [
  { key: 'business', name: 'Business', icon: 'box', tone: 'peach' },
  { key: 'markets', name: 'Markets', icon: 'card', tone: 'mint' },
  { key: 'tech', name: 'Technology', icon: 'grid', tone: 'lavender' },
  { key: 'world', name: 'World', icon: 'globe', tone: 'blue' },
  { key: 'local', name: 'Your city', icon: 'pin', tone: 'sand' },
  { key: 'health', name: 'Health & living', icon: 'heart', tone: 'rose' },
  { key: 'sport', name: 'Sport', icon: 'activity', tone: 'peach' },
]

export const AUTONOMY = [
  { value: 'Ask me first', blurb: 'I check with you before I do anything at all.' },
  { value: 'Small things', blurb: 'I handle the low-stakes bits and tell you. Money or people, I ask.' },
  { value: 'Act and update me', blurb: 'I act on most things and keep you posted. Only the big calls wait.' },
]

export const VOICE_PREVIEW: Record<string, string> = {
  'Professional|Concise': 'Flight PK-301 is delayed 40 minutes. New boarding: 9:10 AM. Your 11:00 stands.',
  'Professional|Detailed':
    'Flight PK-301 is delayed by 40 minutes; boarding is now 9:10 AM at gate B4. Traffic is light, so leaving at 7:45 AM keeps a comfortable margin. Your 11:00 call is unaffected.',
  'Casual|Concise': 'Heads up - flight’s 40 min late. Board at 9:10. Your 11am is fine.',
  'Casual|Detailed':
    'Heads up - your flight slipped 40 minutes, boarding’s now 9:10 at B4. Roads look clear, leaving at 7:45 still works easy. Your 11am call doesn’t clash.',
  'Friendly|Concise': 'Good news first: your 11:00 is safe. Flight’s 40 min late - board 9:10. Extra coffee time ☕',
  'Friendly|Detailed':
    'Small change of plans - your flight is 40 minutes late, boarding now 9:10 at gate B4. Silver lining: time for a proper coffee. Leaving at 7:45 still works, and your 11:00 call is untouched.',
}

export const formatTime = (t: string): string => {
  const [hs, m] = t.split(':')
  let h = Number(hs)
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m} ${ap}`
}

export interface OnboardingState {
  screen: Screen
  cc: string
  phone: string
  code: string[]
  name: string
  tz: string
  times: { brief: string; start: string; end: string; wrap: string }
  proactivity: string
  skills: string[]
  tone: string
  detail: string
  connected: string[]
  interests: string[]
  places: { home: string; office: string }
  runsBusiness: boolean
  autonomy: string
  quiet: { from: string; to: string }
}

const PERSIST_KEY = 'wingman.onboarding'

const defaultOnboardingState = (): OnboardingState => ({
  screen: 'splash',
  cc: '+92',
  phone: '',
  code: ['', '', '', '', '', ''],
  name: '',
  tz: detectTimezone(),
  times: { brief: '07:00', start: '09:00', end: '18:00', wrap: '20:00' },
  proactivity: 'Moderate',
  skills: SKILLS.map((s) => s.name),
  tone: 'Friendly',
  detail: 'Concise',
  connected: [],
  interests: ['business', 'markets', 'tech', 'world', 'local'],
  places: { home: '', office: '' },
  runsBusiness: true,
  autonomy: 'Small things',
  quiet: { from: '22:00', to: '07:00' },
})

// Restore an in-progress onboarding so a refresh resumes instead of restarting.
const loadOnboardingState = (): OnboardingState => {
  let s = defaultOnboardingState()
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (raw) s = { ...s, ...(JSON.parse(raw) as Partial<OnboardingState>) }
  } catch {
    /* ignore */
  }
  return s
}

/** Jump the (persisted) onboarding to a screen — used when a Google/Apple
 *  sign-in comes back to #/auth-callback before the wizard is mounted. */
export const setOnboardingScreen = (screen: Screen, patch: Partial<OnboardingState> = {}) => {
  try {
    const s = { ...loadOnboardingState(), ...patch, screen }
    localStorage.setItem(PERSIST_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

// ── Pending account: signed up (email / Google / Apple) but the WhatsApp
// number isn't verified yet. Its token goes with /verify-otp to link them.
const PENDING_KEY = 'wingman.pendingAccount'
export type PendingAccount = { token: string; name?: string | null; email?: string | null }

export const getPendingAccount = (): PendingAccount | null => {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as PendingAccount) : null
  } catch {
    return null
  }
}

export const setPendingAccount = (p: PendingAccount | null) => {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p))
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    /* ignore */
  }
}

export const clearOnboardingState = () => {
  try {
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    /* ignore */
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(loadOnboardingState)

  // Persist progress on every change so a refresh can resume mid-flow.
  useEffect(() => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(state))
    } catch {
      /* ignore */
    }
  }, [state])

  const set = <K extends keyof OnboardingState>(key: K, value: OnboardingState[K]) =>
    setState((s) => ({ ...s, [key]: value }))

  const go = (screen: Screen) => set('screen', screen)

  const toggleSkill = (name: string) =>
    setState((s) => ({
      ...s,
      skills: s.skills.includes(name) ? s.skills.filter((x) => x !== name) : [...s.skills, name],
    }))

  const toggleInterest = (key: string) =>
    setState((s) => ({
      ...s,
      interests: s.interests.includes(key) ? s.interests.filter((x) => x !== key) : [...s.interests, key],
    }))

  const connect = (service: string) =>
    setState((s) => (s.connected.includes(service) ? s : { ...s, connected: [...s.connected, service] }))

  const fullPhone = `${state.cc} ${state.phone.trim()}`
  const phoneValid = state.phone.replace(/\D/g, '').length >= 7
  const codeComplete = state.code.every((d) => d !== '')
  const nameValid = state.name.trim().length >= 2
  const preview = VOICE_PREVIEW[`${state.tone}|${state.detail}`]

  // ── Real auth against the Wingman backend (via src/data/api) ──────────
  const [busy, setBusy] = useState(false)

  // E.164 digits: country code + number, minus a stray leading zero. Guard
  // against a DOUBLED country code — if the user left/typed "92" in the number
  // field too, don't produce "9292…" (that made an invalid number → "could not
  // send the code"). A PK mobile after +92 starts with 3, never the country code,
  // so stripping a leading cc from the number field here is safe.
  const phoneE164 = () => {
    const cc = state.cc.replace(/\D/g, '')
    let num = state.phone.replace(/\D/g, '').replace(/^0+/, '')
    if (cc && num.startsWith(cc) && num.length > cc.length + 6) num = num.slice(cc.length)
    return cc + num
  }

  // What the backend said about the last code request (was it delivered, or
  // must the user message Wingman to get it?). Survives a reload.
  const [otpReq, setOtpReq] = useOtpRequest()

  // Ask the backend to send the WhatsApp OTP. Returns an error message or null.
  const sendCode = async (): Promise<string | null> => {
    setBusy(true)
    try {
      setOtpReq(await api.requestOtp(phoneE164()))
      return null
    } catch (e) {
      return e instanceof ApiError ? e.message : 'Could not send the code. Check the number.'
    } finally {
      setBusy(false)
    }
  }

  const cap = (v: unknown): string =>
    typeof v === 'string' && v ? v.charAt(0).toUpperCase() + v.slice(1) : ''

  // PREFILL the flow with whatever the backend already knows, so onboarding
  // always runs but is never a blank form for someone who has been here
  // before, and mark the session signed in.
  const applySignedIn = (user: unknown) => {
    const u = user as Record<string, unknown> | null
    if (u) {
        setState((s) => ({
          ...s,
          name: (u.name as string) || s.name,
          tz: (u.timezone as string) || s.tz,
          times: {
            brief: (u.briefing_time as string) || s.times.brief,
            start: (u.work_hours_start as string) || s.times.start,
            end: (u.work_hours_end as string) || s.times.end,
            wrap: (u.debrief_time as string) || s.times.wrap,
          },
          proactivity: cap(u.proactiveness_level) || s.proactivity,
          tone: cap(u.tone) || s.tone,
        }))
    }
    // Verified + token stored → sign the session in (so the Gate doesn't fall
    // back to "Welcome back"). We deliberately do NOT auto-skip onboarding for
    // "already complete" users: the wizard always runs so the user sets their
    // name/details and it saves cleanly. onboarded is set only on finish.
    signIn()
  }

  const verifyCode = async (): Promise<string | null> => {
    setBusy(true)
    try {
      const pending = getPendingAccount()
      const res = await api.verifyOtp(phoneE164(), state.code.join(''), pending?.token)
      setPendingAccount(null)
      applySignedIn(res.user)
      return null
    } catch (e) {
      return e instanceof ApiError ? e.message : 'That code did not work.'
    } finally {
      setBusy(false)
    }
  }

  // Save everything the onboarding collected, mapped to what the backend
  // accepts. Best-effort — a hiccup here must never trap the user on the last
  // screen.
  const finish = async (): Promise<string | null> => {
    // onboarding skill NAMES → backend enabled_skills IDs
    const skillIds: Record<string, string> = {
      'Travel Assistant': 'travel_assistant',
      'Bill Tracker': 'bill_tracker',
      'Delivery Tracker': 'delivery_tracker',
      'People CRM': 'people_crm',
      'Follow-up Tracker': 'followup_tracker',
    }
    // interest keys → valid news topic keys
    const topicIds: Record<string, string> = {
      business: 'business', markets: 'business', tech: 'technology',
      world: 'world', local: 'local', health: 'health', sport: 'sports',
    }
    // autonomy labels → backend ids
    const autonomyIds: Record<string, string> = {
      'Ask me first': 'ask',
      'Small things': 'small',
      'Act and update me': 'act',
    }
    const patch: Record<string, unknown> = {
      name: state.name.trim(),
      timezone: state.tz,
      briefing_time: state.times.brief,
      debrief_time: state.times.wrap,
      work_hours_start: state.times.start,
      work_hours_end: state.times.end,
      tone: state.tone.toLowerCase(),
      communication_style: state.detail.toLowerCase(),
      proactiveness_level: state.proactivity.toLowerCase(),
      enabled_skills: state.skills.map((s) => skillIds[s]).filter(Boolean),
      news_topics: [...new Set(state.interests.map((k) => topicIds[k]).filter(Boolean))],
      // Previously collected but never saved — so the AI never knew them.
      autonomy_level: autonomyIds[state.autonomy] || 'small',
      quiet_hours_start: state.quiet.from,
      quiet_hours_end: state.quiet.to,
      runs_business: state.runsBusiness,
    }
    try {
      await api.completeOnboarding(patch)
      // Home/office go through their own endpoint. Save them INDEPENDENTLY —
      // previously one shared try/catch meant a failing home save (Maps quota /
      // network) silently skipped the office save, leaving a stale office that
      // the WhatsApp AI then used for routing.
      await Promise.allSettled([
        state.places.home.trim() ? api.savePlace('home', state.places.home.trim()) : Promise.resolve(),
        state.places.office.trim() ? api.savePlace('office', state.places.office.trim()) : Promise.resolve(),
      ])
      clearOnboardingState() // setup saved — drop the resume snapshot
      return null
    } catch (e) {
      // Surface the failure so we don't mark the user "done" with nothing saved.
      return e instanceof ApiError ? e.message : 'Could not save your setup. Check your connection and try again.'
    }
  }

  // Start a REAL connection. Google (Calendar/Gmail) opens the backend OAuth in
  // a new tab — one consent connects Calendar + Gmail + Tasks + Drive together.
  // Health/Shopify keep the local mark for now (wired in the connections step).
  const openConnect = (service: string) => {
    if (service === 'Google Calendar' || service === 'Gmail') {
      openExternal(api.googleConnectUrl(phoneE164()))
      return
    }
    connect(service)
  }

  // Pull the REAL connection state from the backend and reflect it in the flow,
  // so a button only shows "Connected" once the OAuth actually completed.
  const refreshConnections = async () => {
    try {
      const c = await api.connections()
      const now: string[] = []
      if (c.calendar) now.push('Google Calendar')
      if (c.gmail) now.push('Gmail')
      if (c.health) now.push('Apple Health & Google Fit')
      if (now.length) setState((s) => ({ ...s, connected: [...new Set([...s.connected, ...now])] }))
    } catch {
      /* ignore */
    }
  }

  // Fill a place from the device's current location (geolocation → reverse
  // geocode), and store it as the traffic origin. Returns an error msg or null.
  const locateMe = (which: 'home' | 'office'): Promise<string | null> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return Promise.resolve('Location is not available on this device.')
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords
          try {
            void api.saveLocation(latitude, longitude) // store as the traffic origin
            const { address } = await api.reverseGeocode(latitude, longitude)
            setState((s) => ({ ...s, places: { ...s.places, [which]: address } }))
            resolve(null)
          } catch (e) {
            resolve(e instanceof ApiError ? e.message : 'Could not get your address from that location.')
          }
        },
        (err) =>
          resolve(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission was blocked. Allow it, then try again.'
              : 'Could not read your location.',
          ),
        { enableHighAccuracy: true, timeout: 10000 },
      )
    })
  }

  return {
    state, set, go, toggleSkill, toggleInterest, connect,
    fullPhone, phoneValid, codeComplete, nameValid, preview,
    busy, sendCode, verifyCode, finish, openConnect, refreshConnections, locateMe,
    otpReq, phoneE164, applySignedIn,
  }
}

export function useSplashAdvance(screen: Screen, go: (s: Screen) => void, ms: number) {
  useEffect(() => {
    if (screen !== 'splash') return
    const t = window.setTimeout(() => go('intro'), ms)
    return () => clearTimeout(t)
  }, [screen, go, ms])
}

// Kept in localStorage: on a phone, switching to WhatsApp and back can reload
// the app, and the "waiting for your message" state must survive that.
const OTP_REQ_KEY = 'wingman.otpReq'

export function useOtpRequest(): [OtpRequest | null, (r: OtpRequest | null) => void] {
  const [req, setReq] = useState<OtpRequest | null>(() => {
    try {
      const raw = localStorage.getItem(OTP_REQ_KEY)
      if (!raw) return null
      const saved = JSON.parse(raw) as OtpRequest & { savedAt?: number }
      const ttl = (saved.expires_in ?? 600) * 1000
      return saved.savedAt && Date.now() - saved.savedAt < ttl ? saved : null
    } catch {
      return null
    }
  })
  const set = (r: OtpRequest | null) => {
    setReq(r)
    try {
      if (r) localStorage.setItem(OTP_REQ_KEY, JSON.stringify({ ...r, savedAt: Date.now() }))
      else localStorage.removeItem(OTP_REQ_KEY)
    } catch {
      /* ignore */
    }
  }
  return [req, set]
}

/**
 * Sign-in by messaging Wingman. When the backend couldn't push the code
 * (new number / outside WhatsApp's 24h window), the user opens a chat with
 * Wingman pre-filled "WM-<ref>" and taps send. Wingman replies with the code,
 * and meanwhile this polls the backend so the app signs in on its own.
 */
export function useWhatsAppSignIn(
  req: OtpRequest | null,
  phone: string,
  onSignedIn: (user: unknown) => void,
) {
  const [opened, setOpened] = useState(false)
  const done = useRef(false)
  const secret = req?.poll_secret
  useEffect(() => {
    done.current = false
    setOpened(false)
  }, [secret])
  useEffect(() => {
    if (!secret || phone.replace(/\D/g, '').length < 8) return
    let stopped = false
    let timer = 0
    const started = Date.now()
    const limit = Math.max(60, req?.expires_in ?? 600) * 1000
    const tick = async () => {
      if (stopped || done.current) return
      try {
        const r = await api.otpStatus(phone, secret)
        if (r.status === 'confirmed') {
          done.current = true
          try { localStorage.removeItem(OTP_REQ_KEY) } catch { /* ignore */ }
          onSignedIn(r.user)
          return
        }
        if (r.status === 'expired' || r.status === 'unknown') return
      } catch {
        /* network blip — keep trying */
      }
      if (!stopped && Date.now() - started < limit) timer = window.setTimeout(tick, 2500)
    }
    timer = window.setTimeout(tick, 2500)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, phone])
  const open = () => {
    if (req?.wa_link) openExternal(req.wa_link)
    setOpened(true)
  }
  return { available: !!req?.wa_link, needed: !!req && !req.delivered, opened, open }
}

export function useResendTimer(active: boolean) {
  const [left, setLeft] = useState(30)
  const [armed, setArmed] = useState(false)
  const restart = () => {
    setLeft(30)
    setArmed(true)
  }
  useEffect(() => {
    if (active && !armed) restart()
  }, [active])
  useEffect(() => {
    if (!armed || left <= 0) return
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [armed, left])
  return { left, canResend: armed && left <= 0, restart }
}

export function useCodeBoxes(code: string[], setCode: (c: string[]) => void) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const onChange = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    // Autofill (keyboard suggestion / one-time-code) drops the WHOLE code into
    // one box — spread it across the boxes instead of keeping one digit.
    if (digits.length >= 4) {
      const start = digits.length >= 6 ? 0 : i
      const next = [...code]
      digits.slice(0, 6 - start).split('').forEach((d, j) => {
        next[start + j] = d
      })
      setCode(next)
      const last = Math.min(start + digits.length, 6) - 1
      refs.current[last]?.focus()
      return
    }
    const next = [...code]
    next[i] = digits.slice(-1)
    setCode(next)
    if (digits && i < 5) refs.current[i + 1]?.focus()
  }
  const onKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code[i] && i > 0) refs.current[i - 1]?.focus()
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6)
    if (!digits) return
    e.preventDefault()
    const next = [...code]
    digits.split('').forEach((d, j) => {
      next[j] = d
    })
    setCode(next)
    refs.current[Math.min(digits.length, 5)]?.focus()
  }
  return { refs, onChange, onKeyDown, onPaste }
}

export function useToast() {
  const [msg, setMsg] = useState('')
  const [show, setShow] = useState(false)
  const timer = useRef<number>()
  const toast = (m: string) => {
    setMsg(m)
    setShow(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShow(false), 2400)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { msg, show, toast }
}
