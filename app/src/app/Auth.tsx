import { useEffect, useState } from 'react'
import { IconChevronL, IconWhatsapp } from './icons'
import { WingGlyph } from '../onboarding/WingGlyph'
import { useCodeBoxes, useResendTimer, setPendingAccount, setOnboardingScreen } from '../onboarding/shared'
import { signIn, markOnboarded, getSession } from '../data/session'
import { navigate } from '../shell/nav'
import { api, ApiError } from '../data/api'
import type { AuthProviders, AuthResult } from '../data/api'
import { t } from '../i18n'
import { toast } from '../shell/toast'
import './app.css'

// Sign up / sign in with an account: Apple, Google, or email + password.
// Ends in onResult(AuthResult) — the caller then either goes in (signed_in)
// or on to the WhatsApp number step (needs_phone).

type Mode = 'signup' | 'signin'
type View = 'choose' | 'email' | 'forgot' | 'reset'

let providersCache: AuthProviders | null = null

const useProviders = () => {
  const [p, setP] = useState<AuthProviders | null>(providersCache)
  useEffect(() => {
    if (providersCache) return
    api
      .authProviders()
      .then((r) => {
        providersCache = r
        setP(r)
      })
      .catch(() => setP({ email: true, google: false, apple: false, phone: true }))
  }, [])
  return p
}

const AppleMark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M16.37 12.6c-.02-2.27 1.86-3.37 1.94-3.42-1.06-1.55-2.71-1.76-3.29-1.78-1.4-.14-2.73.82-3.44.82-.71 0-1.8-.8-2.96-.78-1.52.02-2.93.89-3.71 2.25-1.59 2.75-.41 6.82 1.13 9.05.76 1.09 1.66 2.31 2.83 2.27 1.14-.05 1.57-.73 2.94-.73 1.37 0 1.76.73 2.96.71 1.22-.02 2-1.11 2.74-2.21.87-1.26 1.22-2.49 1.24-2.55-.03-.01-2.37-.91-2.38-3.63zM14.12 5.93c.62-.76 1.05-1.81.93-2.86-.9.04-2 .6-2.64 1.36-.58.67-1.09 1.75-.95 2.78 1.01.08 2.03-.51 2.66-1.28z" />
  </svg>
)

const GoogleMark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
)

const Shell = ({
  back,
  title,
  body,
  children,
  actions,
}: {
  back?: () => void
  title: string
  body?: string
  children?: React.ReactNode
  actions?: React.ReactNode
}) => (
  <div className="gh wg--panel wg-auth-root" data-feedback="quiet">
    <div className="wg-screen wg-screen--flow">
      {back && (
        <div className="wg-topbar">
          <button className="wg-back" data-feedback="back" aria-label={t('Back')} onClick={back}>
            <IconChevronL size={22} />
          </button>
        </div>
      )}
      <div className="wg-main">
        <h1 className="wg-h1">{t(title)}</h1>
        {body && <p className="wg-body">{t(body)}</p>}
        <div className="wg-content">{children}</div>
      </div>
      {actions && <div className="wg-actions wg-actions--stack">{actions}</div>}
    </div>
  </div>
)

const Field = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <div className="wg-field wg-auth-field">
    <input {...props} />
  </div>
)

const errOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : t(fallback))

export const AuthScreens = ({
  initialMode = 'signup',
  onResult,
  onPhone,
  onBack,
}: {
  initialMode?: Mode
  onResult: (res: AuthResult) => void
  /** "Continue with WhatsApp number" — the phone-only sign in. */
  onPhone?: () => void
  onBack?: () => void
}) => {
  const providers = useProviders()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [view, setView] = useState<View>('choose')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const boxes = useCodeBoxes(code, setCode)
  const resend = useResendTimer(view === 'reset')

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
  const passOk = password.length >= 8

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(errOf(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  const submitEmail = () =>
    run(async () => {
      const res = mode === 'signup' ? await api.signUp(name.trim(), email.trim(), password) : await api.logIn(email.trim(), password)
      onResult(res)
    }, mode === 'signup' ? 'Could not create your account.' : 'Could not sign you in.')

  const sendReset = () =>
    run(async () => {
      const r = await api.forgotPassword(email.trim())
      setHint(r.phone_hint || '')
      setCode(['', '', '', '', '', ''])
      setPassword('')
      setView('reset')
    }, 'Could not send the code.')

  const doReset = () =>
    run(async () => {
      onResult(await api.resetPassword(email.trim(), code.join(''), password))
    }, 'That code did not work.')

  const startProvider = (p: 'google' | 'apple') => {
    window.location.href = api.providerStartUrl(p)
  }

  // ── choose a method ──
  if (view === 'choose')
    return (
      <div className="gh wg--panel wg-auth-root" data-feedback="quiet">
        <div className="wg-screen wg-screen--flow">
          {onBack && (
            <div className="wg-topbar">
              <button className="wg-back" data-feedback="back" aria-label={t('Back')} onClick={onBack}>
                <IconChevronL size={22} />
              </button>
            </div>
          )}
          <div className="wg-main wg-main--center">
            <WingGlyph className="wg-welcome__mark" />
            <h1 className="wg-h1">{mode === 'signup' ? t('Create your account') : t('Welcome back')}</h1>
            <p className="wg-body">
              {mode === 'signup'
                ? t("One account for Wingman everywhere. Next, I'll connect your WhatsApp.")
                : t('Sign in the way you signed up.')}
            </p>
          </div>
          <div className="wg-actions wg-actions--stack wg-auth-actions">
            {providers?.apple && (
              <button className="wg-btn full wg-auth-btn wg-auth-btn--apple" onClick={() => startProvider('apple')}>
                <AppleMark /> {t('Continue with Apple')}
              </button>
            )}
            {providers?.google && (
              <button className="wg-btn full outline wg-auth-btn" onClick={() => startProvider('google')}>
                <GoogleMark /> {t('Continue with Google')}
              </button>
            )}
            <button className="wg-btn full outline wg-auth-btn" onClick={() => setView('email')}>
              {mode === 'signup' ? t('Sign up with email') : t('Sign in with email')}
            </button>
            {mode === 'signin' && onPhone && (
              <button className="wg-btn full outline wg-auth-btn" onClick={onPhone}>
                <IconWhatsapp size={20} /> {t('Continue with WhatsApp number')}
              </button>
            )}
            <p className="wg-auth-switch">
              {mode === 'signup' ? t('Already have an account?') : t('New to Wingman?')}{' '}
              <button className="wg-btn-text" onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
                {mode === 'signup' ? t('Sign in') : t('Create an account')}
              </button>
            </p>
            {mode === 'signup' && (
              <p className="wg-auth-legal">
                {t('By continuing you agree to our')}{' '}
                <a href="https://imyourwingman.ai/privacy/" target="_blank" rel="noreferrer">
                  {t('Privacy Policy')}
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </div>
    )

  // ── email + password ──
  if (view === 'email')
    return (
      <Shell
        back={() => setView('choose')}
        title={mode === 'signup' ? 'Sign up with email' : 'Sign in with email'}
        body={mode === 'signup' ? 'Pick a password with at least 8 characters.' : undefined}
        actions={
          <button
            className="wg-btn full"
            disabled={busy || !emailOk || !password || (mode === 'signup' && (!passOk || name.trim().length < 2))}
            onClick={() => void submitEmail()}
          >
            {mode === 'signup' ? t('Create account') : t('Sign in')}
          </button>
        }
      >
        <div className="wg-auth-form">
          {mode === 'signup' && (
            <Field
              placeholder={t('Your name')}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <Field
            type="email"
            inputMode="email"
            placeholder={t('Email')}
            autoComplete="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="wg-field wg-auth-field">
            <input
              type={show ? 'text' : 'password'}
              placeholder={t('Password')}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && emailOk && password) void submitEmail()
              }}
            />
            <button type="button" className="wg-btn-text wg-auth-show" onClick={() => setShow(!show)}>
              {show ? t('Hide') : t('Show')}
            </button>
          </div>
          {mode === 'signin' && (
            <button className="wg-btn-text wg-auth-forgot" onClick={() => setView('forgot')}>
              {t('Forgot password?')}
            </button>
          )}
        </div>
      </Shell>
    )

  // ── forgot: code goes to the WhatsApp number on the account ──
  if (view === 'forgot')
    return (
      <Shell
        back={() => setView('email')}
        title="Reset your password"
        body="I'll send a code to the WhatsApp number on your account."
        actions={
          <button className="wg-btn full" disabled={busy || !emailOk} onClick={() => void sendReset()}>
            {t('Send code')}
          </button>
        }
      >
        <Field
          type="email"
          inputMode="email"
          placeholder={t('Email')}
          autoComplete="email"
          autoCapitalize="none"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Shell>
    )

  // ── reset: code + new password ──
  return (
    <Shell
      back={() => setView('forgot')}
      title="Enter the code"
      body={hint ? t('Sent on WhatsApp to {phone}. Then choose a new password.', { phone: hint }) : t('Sent on WhatsApp. Then choose a new password.')}
      actions={
        <button className="wg-btn full" disabled={busy || !code.every((d) => d) || !passOk} onClick={() => void doReset()}>
          {t('Save and sign in')}
        </button>
      }
    >
      <div className="wg-code" onPaste={boxes.onPaste}>
        {code.map((d, i) => (
          <input
            key={i}
            ref={(el) => (boxes.refs.current[i] = el)}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={t('Digit {n}', { n: i + 1 })}
            value={d}
            onChange={(e) => boxes.onChange(i, e.target.value)}
            onKeyDown={(e) => boxes.onKeyDown(i, e)}
          />
        ))}
      </div>
      <div className="wg-auth-form">
        <div className="wg-field wg-auth-field">
          <input
            type={show ? 'text' : 'password'}
            placeholder={t('New password (8+ characters)')}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="wg-btn-text wg-auth-show" onClick={() => setShow(!show)}>
            {show ? t('Hide') : t('Show')}
          </button>
        </div>
      </div>
      <p className="wg-note">
        {resend.canResend ? (
          <button
            className="wg-btn-text"
            onClick={() => {
              resend.restart()
              void sendReset()
            }}
          >
            {t('Resend code')}
          </button>
        ) : (
          <>{t('Resend available in {seconds}s', { seconds: resend.left })}</>
        )}
      </p>
    </Shell>
  )
}

// Google / Apple come back to #/auth-callback?code=… (or ?error=…). Swap the
// one-time code for a sign-in, then land in the right place.
export const AuthCallback = ({ route }: { route: string }) => {
  const [error, setError] = useState('')
  useEffect(() => {
    const q = new URLSearchParams(route.split('?')[1] || '')
    const err = q.get('error')
    const code = q.get('code')
    if (err || !code) {
      setError(err || t('Sign-in was cancelled.'))
      return
    }
    void (async () => {
      try {
        const res = await api.exchangeSignIn(code)
        const returning = getSession().onboarded
        if (res.status === 'needs_phone') {
          setPendingAccount({ token: res.account_token, name: res.account.name, email: res.account.email })
          if (returning) navigate('signin')
          else {
            setOnboardingScreen('phone', res.account.name ? { name: res.account.name } : {})
            navigate('')
          }
          return
        }
        setPendingAccount(null)
        const done = !!(res.user as { onboarding_complete?: boolean | number }).onboarding_complete
        if (done) markOnboarded()
        else if (!returning) setOnboardingScreen('name', { name: String((res.user as { name?: string }).name || '') })
        signIn()
        navigate(done || returning ? 'home' : '')
      } catch (e) {
        setError(errOf(e, 'Sign-in failed. Please try again.'))
      }
    })()
  }, [route])

  return (
    <Shell
      title={error ? 'Sign-in didn\'t finish' : 'Signing you in…'}
      body={error || undefined}
      actions={
        error ? (
          <button className="wg-btn full" onClick={() => (window.location.hash = '#/')}>
            {t('Try again')}
          </button>
        ) : undefined
      }
    />
  )
}
