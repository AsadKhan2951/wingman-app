// The one door to the Wingman backend — the SAME API that WhatsApp and the
// existing web client already run on. This app's src/data/* modules call
// through here so the exact UI carries real, dynamic data. Nothing on the
// server changes.
//
// Base URL: VITE_API_BASE if set (e.g. http://localhost:3000 for a local
// backend), otherwise the live server. CORS on the backend is open, so the
// app can call it straight from the browser with a Bearer token.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? 'https://imyourwingman.ai'

const TOKEN_KEY = 'wingman.token'

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export const setToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export const isSignedIn = (): boolean => !!getToken()

// Connect links (/auth/google?phone=…) must carry a signature the server
// issued to THIS user, so nobody can attach their account to someone else's
// number. The server hands it out at sign-in and on /me.
const SIG_KEY = 'wingman.connectSig'
const setConnectSig = (sig: unknown) => {
  if (typeof sig !== 'string' || !sig) return
  try {
    localStorage.setItem(SIG_KEY, sig)
  } catch {
    /* ignore */
  }
}
const getConnectSig = (): string => {
  try {
    return localStorage.getItem(SIG_KEY) || ''
  } catch {
    return ''
  }
}

export type OtpRequest = {
  sent?: boolean
  delivered: boolean
  channel?: 'text' | 'template' | 'reply'
  ref?: string
  poll_secret?: string
  wa_link?: string | null
  expires_in?: number
  dev_code?: string
}

// ── Meetings shapes (backend /api/meetings) ──
export type ServerMeetingSummary = {
  overview?: string
  discussion?: string[]
  decisions?: string[]
  actions?: { task: string; owner?: string; due?: string; priority?: 'High' | 'Medium' | 'Low' }[]
  openQuestions?: string[]
  followUps?: string[]
}
export type ServerMeeting = {
  id: string
  title?: string
  type?: string
  company?: string
  location?: string
  virtual?: boolean
  attendees?: { name?: string; email?: string; role?: string; phone?: string }[]
  notes?: string
  summary?: ServerMeetingSummary | null
  status?: string
  meeting_at?: string
  emailed_at?: string
  recording_url?: string | null
}
export type EmailResult = { sent: string[]; failed: string[]; skipped: boolean; reason?: string }
export type AttendeeNotify = { sent: string[]; failed: { name: string; reason: string }[]; skipped?: string }

export type GoogleAccount = { id: string; email: string | null; is_primary: boolean; connected_at: string }

// A notetaker bot session (meeting_bots row) — its live status drives the UI.
export type BotSession = {
  id: string
  meeting_id?: string | null
  meeting_url?: string | null
  provider?: string | null
  bot_name?: string | null
  status?: string
  recall_bot_id?: string | null
  scheduled_at?: string | null
  error?: string | null
  created_at?: string
}

// ── In-app assistant chat (same brain as WhatsApp) ──
export type BrowserCard = { type: 'browser'; url: string; title?: string; shot?: string | null; loggedIn?: boolean }
export type LiveAgentCard = { type: 'live_agent'; url: string; sessionId: string; liveViewUrl: string; goal: string }
export type AssistantCard = BrowserCard | LiveAgentCard
export type AssistantMessage = { role: 'user' | 'assistant'; text: string; at?: string }
export type AssistantReply = { reply: string; ignored?: boolean; cards?: AssistantCard[] }
export type LiveSession = { sessionId: string; liveViewUrl: string; url: string }
export type AgentStep = { n: number; action: string; index?: number | null; detail?: string }
export type AgentStatus = {
  found: boolean
  status?: string
  steps?: AgentStep[]
  result?: string | null
  error?: string | null
  done?: boolean
  goal?: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken()
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `${method} ${path} → ${res.status}`
    try {
      const j = (await res.json()) as { error?: string }
      if (j?.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg)
  }
  // some endpoints (logout) may return empty
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}

const get = <T>(path: string) => req<T>('GET', path)

export type AuthProviders = { email: boolean; google: boolean; apple: boolean; phone: boolean }
export type AuthAccount = { id: string; email: string | null; name: string | null; linked: boolean }
export type AuthResult =
  | { status: 'signed_in'; token: string; user: Record<string, unknown>; connect_sig?: string; account?: AuthAccount }
  | { status: 'needs_phone'; account_token: string; account: AuthAccount }

async function authCall(path: string, body: unknown): Promise<AuthResult> {
  const res = await req<AuthResult>('POST', path, body)
  if (res.status === 'signed_in') {
    setToken(res.token)
    setConnectSig(res.connect_sig)
  }
  return res
}

export const api = {
  base: BASE,

  // ── Auth (real OTP over WhatsApp, from the backend) ──
  // delivered=false → the code couldn't be pushed (new number / outside
  // WhatsApp's 24h window). The user then messages Wingman via wa_link and the
  // app polls otpStatus with poll_secret to sign in.
  requestOtp: (phone: string) => req<OtpRequest>('POST', '/auth/request-otp', { phone }),
  otpStatus: async (phone: string, pollSecret: string) => {
    const res = await req<{ status: 'pending' | 'confirmed' | 'expired' | 'unknown'; token?: string; user?: unknown }>(
      'POST', '/auth/otp-status', { phone, poll_secret: pollSecret },
    )
    if (res.status === 'confirmed' && res.token) setToken(res.token)
    setConnectSig((res as { connect_sig?: string }).connect_sig)
    return res
  },
  // accountToken: from sign up (email / Google / Apple) — verifying the number
  // links that account to the Wingman user.
  verifyOtp: async (phone: string, code: string, accountToken?: string | null) => {
    const res = await req<{ token: string; user: unknown; connect_sig?: string }>('POST', '/auth/verify-otp', {
      phone,
      code,
      ...(accountToken ? { account_token: accountToken } : {}),
    })
    if (res.token) setToken(res.token)
    setConnectSig(res.connect_sig)
    return res
  },

  // ── Accounts: email + password, Google, Apple ──
  // Every call answers AuthResult: signed in (token stored), or needs_phone
  // (keep account_token and go verify the WhatsApp number).
  authProviders: () => get<AuthProviders>('/auth/providers'),
  signUp: (name: string, email: string, password: string) =>
    authCall('/auth/signup', { name, email, password }),
  logIn: (email: string, password: string) => authCall('/auth/login', { email, password }),
  forgotPassword: (email: string) =>
    req<{ sent: boolean; phone_hint?: string; dev_code?: string }>('POST', '/auth/forgot', { email }),
  resetPassword: (email: string, code: string, password: string) =>
    authCall('/auth/reset', { email, code, password }),
  exchangeSignIn: (code: string) => authCall('/auth/exchange', { code }),
  // Google / Apple: the browser goes to the provider and comes back to
  // #/auth-callback?code=… (or ?error=…).
  providerStartUrl: (provider: 'google' | 'apple') => `${BASE}/api/auth/${provider}/start`,
  authMe: () => get<{ user: unknown }>('/auth/me'),
  // Permanently delete the account and everything stored for it.
  deleteAccount: async () => {
    await req<{ deleted: boolean }>('POST', '/account/delete', { confirm: 'DELETE' })
    setToken(null)
  },
  logout: async () => {
    try {
      await req('POST', '/auth/logout')
    } finally {
      setToken(null)
    }
  },

  // ── Profile / settings ──
  me: async () => {
    const res = await get<Record<string, unknown>>('/me')
    setConnectSig(res.connect_sig)
    return res
  },
  updateMe: (patch: Record<string, unknown>) => req<{ user: unknown }>('PATCH', '/me', patch),
  completeOnboarding: (patch: Record<string, unknown>) => req<{ user: unknown }>('POST', '/onboarding/complete', patch),

  // ── Meeting notetaker (user preference; on = Wingman auto-joins + notes) ──
  setAutoJoin: (enabled: boolean) => req<{ autoJoinMeetings: boolean }>('POST', '/meetings/auto-join', { enabled }),
  setMeetingRecording: (enabled: boolean) => req<{ saveMeetingRecording: boolean }>('POST', '/meetings/recording', { enabled }),
  // Email priorities (onboarding): free-form context + a notify toggle. The AI
  // reads this to decide which emails to proactively surface on WhatsApp.
  setEmailContext: (body: { instructions: string; notify: boolean }) =>
    req<{ email_context: { instructions: string; notify: boolean } }>('POST', '/email-context', body),
  // Send the Wingman bot into a meeting right now. From the calendar, pass the
  // event's gcalEventId (the bot joins that exact meeting); or pass a raw
  // Meet/Zoom/Teams link. Either way the bot joins within ~30s — reliable and
  // timezone-independent.
  joinMeeting: (body: { gcalEventId?: string; meetingUrl?: string }) =>
    req<{ session: BotSession | null; queued: boolean; workerReady: boolean; note?: string }>(
      'POST', '/meetings/join', body,
    ),

  // ── Data (domain modules map these onto the UI's shapes) ──
  dashboard: () => get<Record<string, unknown>>('/dashboard'),
  calendar: () => get<{ events: unknown[]; mock?: boolean }>('/calendar'),
  emails: () => get<{ emails: unknown[]; mock?: boolean }>('/emails'),
  // Open one email with its full body (fetched live from Gmail / business mailbox).
  emailBody: (id: string) =>
    get<{ id: string; sender: string; subject: string; body: string; summary: string; category: string; source: 'gmail' | 'webmail'; created_at: string }>(
      `/emails/${encodeURIComponent(id)}`,
    ),
  tasks: () => get<{ tasks: unknown[]; mock?: boolean }>('/tasks'),
  bills: () => get<{ bills: unknown[]; mock?: boolean }>('/bills'),
  deliveries: () => get<{ deliveries: unknown[]; mock?: boolean }>('/deliveries'),
  travel: () => get<{ trips: unknown[]; mock?: boolean }>('/travel'),
  health: () => get<{ health: unknown; mock?: boolean }>('/health-data'),
  contacts: () => get<{ contacts: unknown[]; mock?: boolean }>('/contacts'),
  followups: () => get<{ followups: unknown[]; mock?: boolean }>('/followups'),
  briefings: () => get<{ briefings: unknown[]; mock?: boolean }>('/briefings'),

  // ── Meetings (notes → AI summary + action items → email attendees + user) ──
  meetings: () => get<{ meetings: ServerMeeting[] }>('/meetings'),
  createMeeting: (body: Record<string, unknown>) => req<{ meeting: ServerMeeting }>('POST', '/meetings', body),
  updateMeeting: (id: string, body: Record<string, unknown>) =>
    req<{ meeting: ServerMeeting }>('PATCH', `/meetings/${encodeURIComponent(id)}`, body),
  finalizeMeeting: (id: string, body: Record<string, unknown> = {}) =>
    req<{ meeting: ServerMeeting; email: EmailResult | null }>('POST', `/meetings/${encodeURIComponent(id)}/finalize`, body),
  sendMeeting: (id: string) =>
    req<{ email: EmailResult | null }>('POST', `/meetings/${encodeURIComponent(id)}/send`),
  // Turn the meeting's action items into real tasks (which then get reminders).
  createMeetingTasks: (id: string) =>
    req<{ created: number; tasks: { id: string; title: string; due_date: string | null }[] }>(
      'POST', `/meetings/${encodeURIComponent(id)}/create-tasks`,
    ),
  // Send the summary to attendees' WhatsApp numbers.
  notifyAttendees: (id: string) =>
    req<AttendeeNotify>('POST', `/meetings/${encodeURIComponent(id)}/notify-attendees`),
  // WhatsApp the briefing + action items to the user's OWN number.
  notifyMe: (id: string) =>
    req<{ ok: boolean; sent: boolean }>('POST', `/meetings/${encodeURIComponent(id)}/notify-me`),
  // Upload a meeting recording → backend transcribes (Whisper) + summarizes (Claude).
  transcribeMeeting: async (id: string, blob: Blob, mime: string) => {
    const res = await fetch(`${BASE}/api/meetings/${encodeURIComponent(id)}/transcribe`, {
      method: 'POST',
      headers: headers({ 'Content-Type': mime || 'application/octet-stream' }),
      body: blob,
    })
    if (!res.ok) throw new ApiError(res.status, `transcribe → ${res.status}`)
    return (await res.json()) as { meeting: ServerMeeting; transcript?: string }
  },

  // ── Connections ──
  // One Google consent connects Calendar + Gmail + Tasks + Drive together
  // (the backend's combined scopes). The flow is keyed by phone.
  googleConnectUrl: (phone: string) =>
    `${BASE}/auth/google?phone=${encodeURIComponent(phone.replace(/\D/g, ''))}&sig=${encodeURIComponent(getConnectSig())}`,
  // Multiple Google accounts: list, set which sends/creates, unlink one.
  googleAccounts: () => get<{ accounts: GoogleAccount[] }>('/google/accounts'),
  setPrimaryGoogleAccount: (id: string) =>
    req<{ accounts: GoogleAccount[] }>('POST', `/google/accounts/${encodeURIComponent(id)}/primary`),
  disconnectGoogleAccount: (id: string) =>
    req<{ accounts: GoogleAccount[] }>('POST', `/google/accounts/${encodeURIComponent(id)}/disconnect`),
  // Real connection state, read from /me.
  connections: async () => {
    const me = await get<Record<string, unknown>>('/me')
    return {
      calendar: !!me.calendar_connected,
      gmail: !!me.gmail_connected,
      health: !!me.health_connected,
    }
  },

  // ── Places (home / office — separate from the settings allow-list) ──
  savePlace: (which: 'home' | 'office', address: string) =>
    req<{ saved: boolean; which: string; address: string }>('POST', '/places', { which, address }),

  // ── Webmail (IMAP/SMTP business email — creds verified + encrypted server-side) ──
  webmailConnect: (body: {
    address: string
    password: string
    imap_host?: string
    imap_port?: number
    smtp_host?: string
    smtp_port?: number
    from_name?: string
  }) =>
    req<{ connected: boolean; address: string; imap_host: string; smtp_host: string; can_send: boolean; send_note: string | null }>(
      'POST',
      '/webmail/connect',
      body,
    ),
  webmailDisconnect: () => req<{ connected: boolean }>('POST', '/webmail/disconnect'),

  // ── Work clock (attendance / HRMS) ──
  //   Inbound: the HRMS POSTs clock events to webhook_url so Wingman notices a
  //   forgotten clock-out. Outbound: Wingman POSTs to the user's own endpoint
  //   (action_url) with an X-Wingman-Secret header so "clock out kar do" works.
  workConnect: () =>
    get<{
      webhook_url: string
      connected: boolean
      action_configured: boolean
      action_url: string | null
      employee_ref: string | null
      nowhrms: { available: boolean; connected: boolean; email: string | null }
    }>('/work/connect'),
  // One-tap NOW HRMS: employee sends only their company email.
  workConnectNowHrms: (email: string) =>
    req<{ ok: boolean; connected: boolean; email: string }>('POST', '/work/nowhrms/connect', { email }),
  workDisconnectNowHrms: () => req<{ ok: boolean; connected: boolean }>('POST', '/work/nowhrms/disconnect'),
  workSetAction: (body: { url: string; secret?: string; employee_ref?: string | null }) =>
    req<{ ok: boolean; configured: boolean; url?: string }>('POST', '/work/action', body),
  workClearAction: () => req<{ ok: boolean; configured: boolean }>('POST', '/work/action', { disconnect: true }),
  workTestAction: (event: 'clock_in' | 'clock_out') =>
    req<{ ok: boolean; event: string; at: string }>('POST', '/work/action/test', { event }),
  workResetLink: () => req<{ webhook_url: string }>('POST', '/work/reset-link'),

  // ── Location (device geolocation → traffic origin + "use my location") ──
  saveLocation: (lat: number, lng: number) =>
    req<{ ok: boolean; label: string | null }>('POST', '/location', { lat, lng }),
  reverseGeocode: (lat: number, lng: number) =>
    req<{ address: string }>('POST', '/location/reverse', { lat, lng }),

  // ── Assistant chat (in-app WhatsApp-style conversation) ──
  assistantHistory: () => get<{ messages: AssistantMessage[] }>('/assistant/history'),
  assistantChat: (text: string) => req<AssistantReply>('POST', '/assistant/chat', { text }),
  // Level 3: open a LIVE cloud browser (watch + take control) and close it.
  browseLive: (url: string) => req<LiveSession>('POST', '/assistant/browse/live', { url }),
  browseStop: (sessionId: string) => req<{ ok: boolean }>('POST', '/assistant/browse/stop', { sessionId }),
  // Level 3b: poll a live AGENT run's progress (steps + result).
  browseAgentStatus: (sessionId: string) =>
    get<AgentStatus>(`/assistant/browse/agent/${encodeURIComponent(sessionId)}`),

  // ── Actions ──
  completeTask: (id: string) => req<{ ok: boolean }>('POST', `/tasks/${id}/complete`),
  deleteTask: (id: string) => req<{ ok: boolean }>('DELETE', `/tasks/${encodeURIComponent(id)}`),
  payBill: (id: string) => req<{ ok: boolean }>('POST', `/bills/${id}/pay`),
}

export type Api = typeof api
