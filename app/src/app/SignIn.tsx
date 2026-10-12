import { useState } from 'react'
import { IconChevronL, IconShield } from './icons'
import { WingGlyph } from '../onboarding/WingGlyph'
import { COUNTRY_CODES, CC_FLAGS, useCodeBoxes, useResendTimer } from '../onboarding/shared'
import { useProfile, firstName } from '../data/store'
import { signIn, signOut, startFresh } from '../data/session'
import { resetProfile } from '../data/store'
import { api, ApiError, setToken } from '../data/api'
import { clearOnboardingState, getPendingAccount, setPendingAccount } from '../onboarding/shared'
import { AuthScreens } from './Auth'
import { confirmAction } from '../shell/confirm'
import { t } from '../i18n'
import { toast } from '../shell/toast'
import { navigate } from '../shell/nav'
import './app.css'



export const confirmSignOut = async () => {
  const ok = await confirmAction({
    title: 'Sign out?',
    body: "I'll stop briefing you on this device until you sign back in. Nothing you've told me is deleted — what I remember and what's waiting on you will be here when you return.",
    confirmLabel: 'Sign me out',
    cancelLabel: 'Stay signed in',
  })
  if (!ok) return
  signOut()
  navigate('welcome')
}


const Step = ({
  idx,
  title,
  body,
  back,
  next,
  nextLabel = 'Continue',
  nextDisabled,
  children,
}: {
  idx: number
  title: string
  body?: string
  back: () => void
  next: () => void
  nextLabel?: string
  nextDisabled?: boolean
  children?: React.ReactNode
}) => (
  <div className="gh wg--panel" data-feedback="quiet">
    <div className="wg-screen wg-screen--flow">
      <div className="wg-topbar">
        <button className="wg-back" data-feedback="back" aria-label={t('Back')} onClick={back}>
          <IconChevronL size={22} />
        </button>
        <div className="wg-track" role="progressbar" aria-valuenow={idx + 1} aria-valuemax={2}>
          {[0, 1].map((i) => (
            <i key={i} className={i <= idx ? 'on' : ''} />
          ))}
        </div>
      </div>
      <div className="wg-main">
        {}
        <h1 className="wg-h1">{t(title)}</h1>
        {body && <p className="wg-body">{t(body)}</p>}
        <div className="wg-content">{children}</div>
      </div>
      <div className="wg-actions wg-actions--stack">
        <button className="wg-btn full" onClick={next} disabled={nextDisabled}>
          {t(nextLabel)}
        </button>
      </div>
    </div>
  </div>
)


export const Welcome = () => {
  const profile = useProfile()
  const hasName = !!profile.name.trim()
  const first = firstName(profile.name)

  const fresh = async () => {
    const ok = await confirmAction({
      title: 'Set this up for someone else?',
      body: t(
        "I'll start over from the first question. {name}'s answers stay on this device until someone finishes setting up over them.",
        { name: first },
      ),
      confirmLabel: 'Start fresh',
      cancelLabel: 'Never mind',
    })
    if (!ok) return
    setToken(null) // drop any stale token
    resetProfile() // drop the cached (possibly mock) name so the greeting is clean
    clearOnboardingState() // drop the saved wizard snapshot (stale phone + consumed code)
    startFresh()
    navigate('')
  }

  return (
    <div className="gh wg--panel" data-feedback="quiet">
      <div className="wg-screen wg-screen--flow">
        <div className="wg-main wg-main--center">
          <WingGlyph className="wg-welcome__mark" />
          <h1 className="wg-h1">{hasName ? t('Welcome back, {name}', { name: first }) : t('Welcome to Wingman')}</h1>
          <p className="wg-body">
            {hasName
              ? t("Everything is where you left it — what I remember, what's waiting on you, all of it. I just need to know it's you.")
              : t('Sign in to your account, or create a new one to get started.')}
          </p>
        </div>
        <div className="wg-actions wg-actions--stack">
          <button className="wg-btn full" onClick={() => navigate('signin')}>
            {t('Sign in')}
          </button>
          <button className="wg-btn-text" onClick={fresh}>
            {hasName ? t('Not {name}? Start fresh', { name: first }) : t('Create an account')}
          </button>
        </div>
      </div>
    </div>
  )
}


const ccOf = (phone: string) => {
  const head = phone.trim().split(/\s+/)[0]
  return COUNTRY_CODES.includes(head) ? head : '+92'
}

export const SignIn = () => {
  const profile = useProfile()
  // 'auth' = Apple / Google / email / "WhatsApp number"; a signed-up account
  // whose number isn't verified yet comes back straight to 'phone'.
  const [step, setStep] = useState<'auth' | 'phone' | 'verify'>(() => (getPendingAccount() ? 'phone' : 'auth'))
  const [cc, setCc] = useState(() => ccOf(profile.phone))
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [busy, setBusy] = useState(false)
  const boxes = useCodeBoxes(code, setCode)
  const resend = useResendTimer(step === 'verify')

  const fullPhone = `${cc} ${phone.trim()}`
  const phoneValid = phone.replace(/\D/g, '').length >= 7
  const codeComplete = code.every((d) => d !== '')

  // E.164 digits (cc + number, leading zeros stripped) — the format the OTP
  // endpoints expect. Mirrors the onboarding flow.
  const phoneE164 = () => {
    const c = cc.replace(/\D/g, '')
    let num = phone.replace(/\D/g, '').replace(/^0+/, '')
    if (c && num.startsWith(c) && num.length > c.length + 6) num = num.slice(c.length)
    return c + num
  }

  // Ask the backend to send the real WhatsApp OTP. Returns true on success.
  const send = async (): Promise<boolean> => {
    setBusy(true)
    try {
      await api.requestOtp(phoneE164())
      return true
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('Could not send the code. Check the number.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Verify the code — this actually authenticates and stores the session token.
  const verify = async () => {
    setBusy(true)
    try {
      await api.verifyOtp(phoneE164(), code.join(''), getPendingAccount()?.token) // stores the bearer token on success
      setPendingAccount(null)
      signIn()
      navigate('home')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('That code didn\'t work. Check it and try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'auth')
    return (
      <AuthScreens
        initialMode="signin"
        onBack={() => navigate('welcome')}
        onPhone={() => {
          setPendingAccount(null)
          setStep('phone')
        }}
        onResult={(res) => {
          if (res.status === 'needs_phone') {
            setPendingAccount({ token: res.account_token, name: res.account.name, email: res.account.email })
            setStep('phone')
            return
          }
          setPendingAccount(null)
          signIn()
          navigate('home')
        }}
      />
    )

  if (step === 'verify')
    return (
      <Step
        idx={1}
        title="Enter your code"
        body={t('Sent on WhatsApp to {phone}.', { phone: fullPhone })}
        back={() => setStep('phone')}
        next={() => void verify()}
        nextLabel="Sign in"
        nextDisabled={!codeComplete || busy}
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
        <p className="wg-note">
          {resend.canResend ? (
            <button className="wg-btn-text" onClick={async () => {
              resend.restart()
              if (await send()) toast('Code re-sent on WhatsApp')
            }}>
              {t('Resend code')}
            </button>
          ) : (
            <>{t('Resend available in {seconds}s', { seconds: resend.left })}</>
          )}
        </p>
      </Step>
    )

  return (
    <Step
      idx={0}
      title="What's your WhatsApp number?"
      body={getPendingAccount() ? "Wingman works on WhatsApp. I'll text you a 6-digit code there to connect it to your account." : "The same one you set me up with. I'll text a 6-digit code to check it's you."}
      back={() => setStep('auth')}
      next={async () => { if (await send()) setStep('verify') }}
      nextLabel="Send my code"
      nextDisabled={!phoneValid || busy}
    >
      <div className="wg-field">
        <select aria-label={t('Country code')} value={cc} onChange={(e) => setCc(e.target.value)}>
          {COUNTRY_CODES.map((c) => (
            <option key={c} value={c}>
              {CC_FLAGS[c] ? `${CC_FLAGS[c]} ${c}` : c}
            </option>
          ))}
        </select>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="300 1234567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <p className="wg-note">
        <IconShield size={16} />
        {t('Your number is only used for our WhatsApp chat. No calls, no spam, ever.')}
      </p>
    </Step>
  )
}
