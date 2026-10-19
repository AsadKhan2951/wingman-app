import { useEffect, useRef, useState } from 'react'
import {
  AUTONOMY,
  CC_FLAGS,
  COUNTRY_CODES,
  INTERESTS,
  PROACTIVITY,
  SKILLS,
  TONES,
  ZONES,
  formatTime,
  useCodeBoxes,
  useOnboarding,
  useResendTimer,
  useSplashAdvance,
  useToast,
  type Screen,
} from '../onboarding/shared'
import {
  Icon,
  IconBell,
  IconCheck,
  IconChevronL,
  IconGCalBrand,
  IconGmailBrand,
  IconClock,
  IconHeart,
  IconShield,
  IconShopifyBrand,
  IconSun,
} from './icons'
import { SKILL_ICONS, SKILL_TONES } from './agent'
import { t } from '../i18n'
import { Switch } from '../shell/Switch'
import { AuthScreens } from './Auth'
import type { AuthResult } from '../data/api'
import { getPendingAccount, setPendingAccount } from '../onboarding/shared'
import { markOnboarded } from '../data/session'
import illoChiefOfStaff from '../assets/illustrations/intro-1.svg'
import illoQuietGuard from '../assets/illustrations/intro-2.svg'
import illoWhatsApp from '../assets/illustrations/intro-3.svg'
import './app.css'

const STEPS: Screen[] = [
  'phone',
  'verify',
  'name',
  'tz',
  'rhythm',
  'proactivity',
  'skills',
  'personality',
  'interests',
  'places',
  'health',
  'business',
  'boundaries',
]

interface StepProps {
  screen: Screen
  title: string
  body?: string
  back?: () => void
  next?: () => void
  nextLabel?: string
  nextDisabled?: boolean
  skip?: () => void
  children?: React.ReactNode
}

const Step = ({ screen, title, body, back, next, nextLabel = 'Continue', nextDisabled, skip, children }: StepProps) => {
  const idx = STEPS.indexOf(screen)
  const inFlow = idx >= 0
  return (
    <div className="wg-screen wg-screen--flow">
      {inFlow && (
        <div className="wg-topbar">
          <button className="wg-back" data-feedback="back" aria-label={t('Back')} onClick={back} disabled={!back}>
            <IconChevronL size={22} />
          </button>
          <div className="wg-track" role="progressbar" aria-valuenow={idx + 1} aria-valuemax={STEPS.length}>
            {STEPS.map((_, i) => (
              <i key={i} className={i <= idx ? 'on' : ''} />
            ))}
          </div>
        </div>
      )}
      <div className="wg-main">
        {}
        <h1 className="wg-h1">{t(title)}</h1>
        {body && <p className="wg-body">{t(body)}</p>}
        <div className="wg-content">{children}</div>
      </div>
      <div className="wg-actions wg-actions--stack">
        {next && (
          <button className="wg-btn full" onClick={next} disabled={nextDisabled}>
            {t(nextLabel)}
          </button>
        )}
        {skip && (
          <button className="wg-btn-text" onClick={skip}>
            {t('Skip')}
          </button>
        )}
        {!inFlow && back && (
          <button className="wg-btn-text" onClick={back}>
            {t('Back')}
          </button>
        )}
      </div>
    </div>
  )
}

const INTRO = [
  {
    illo: illoChiefOfStaff,
    title: 'Meet Wingman, your chief of staff',
    body: 'I keep an eye on your calendar, inbox and tasks, then tell you what actually matters most, before you even ask.',
  },
  {
    illo: illoQuietGuard,
    title: 'I work quietly in the background',
    body: 'You stay in control: I only act within the permissions you give me, and important actions always ask first.',
  },
  {
    illo: illoWhatsApp,
    title: 'We talk\non WhatsApp',
    body: 'No new inbox to check. Your briefings, alerts and answers arrive right in the chat you already open every day.',
  },
]

export const Onboarding = ({ onDone }: { onDone: () => void }) => {
  const ob = useOnboarding()
  const {
    state, set, go, toggleSkill, toggleInterest, fullPhone, phoneValid, codeComplete, nameValid, preview,
    busy, sendCode, verifyCode, finish, openConnect, refreshConnections, locateMe, applySignedIn,
  } = ob

  // Account step (Apple / Google / email). New account → WhatsApp number next;
  // an existing, already-linked account → straight in (or on to finish setup).
  const onAuthResult = (res: AuthResult) => {
    if (res.status === 'needs_phone') {
      setPendingAccount({ token: res.account_token, name: res.account.name, email: res.account.email })
      if (res.account.name && !state.name.trim()) set('name', res.account.name)
      go('phone')
      return
    }
    setPendingAccount(null)
    applySignedIn(res.user)
    if (res.user && (res.user as { onboarding_complete?: boolean | number }).onboarding_complete) {
      markOnboarded()
      onDone()
    } else go('name')
  }
  const { msg, show, toast } = useToast()
  const [locating, setLocating] = useState<'home' | 'office' | null>(null)
  const useMyLocation = async (which: 'home' | 'office') => {
    setLocating(which)
    const err = await locateMe(which)
    setLocating(null)
    toast(err ?? t('Location added'))
  }
  const resend = useResendTimer(state.screen === 'verify')
  const code = useCodeBoxes(state.code, (c) => set('code', c))
  const [pane, setPane] = useState(0)
  const panesRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useSplashAdvance(state.screen, go, 1200)

  useEffect(() => {
    const input = rootRef.current?.querySelector<HTMLInputElement>('input:not([type="time"])')
    input?.focus({ preventScroll: true })
  }, [state.screen])

  // Returning from a Google OAuth tab (window regains focus) → refresh the real
  // connection state so a button only turns green once it actually connected.
  useEffect(() => {
    const onFocus = () => void refreshConnections()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPaneScroll = () => {
    const el = panesRef.current
    if (el) setPane(Math.round(el.scrollLeft / el.clientWidth))
  }

  const goPane = (i: number) => {
    const el = panesRef.current
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' })
  }

  if (state.screen === 'splash')
    return (
      <div className="gh wg--panel" data-feedback="quiet">
        <div className="wg-screen wg-splash">
          <span className="wg-splash-mark">wingman</span>
        </div>
      </div>
    )

  return (
    <div className="gh wg--panel" data-feedback="quiet" ref={rootRef}>
      {state.screen === 'intro' && (
        <div className="wg-screen">
          <div className="wg-panes" ref={panesRef} onScroll={onPaneScroll}>
            {INTRO.map((p) => (
              <section className="wg-pane" key={p.title}>
                <div className="wg-illo">
                  <img src={p.illo} alt="" className="art" />
                </div>
                <h1 className="wg-h1 wg-pane-title">{t(p.title)}</h1>
                <p className="wg-body wg-pane-body">{t(p.body)}</p>
              </section>
            ))}
          </div>
          <div className="wg-actions wg-actions--intro">
            <div className="wg-dots">
              {INTRO.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={i === pane ? 'on' : ''}
                  aria-label={t('Go to screen {n}', { n: i + 1 })}
                  onClick={() => goPane(i)}
                />
              ))}
            </div>
            <button
              className="wg-btn full"
              onClick={() => (pane < INTRO.length - 1 ? goPane(pane + 1) : go('auth'))}
            >
              {pane < INTRO.length - 1 ? t('Next') : t('Get started')}
            </button>
          </div>
        </div>
      )}

      {state.screen === 'auth' && (
        <AuthScreens
          initialMode="signup"
          onResult={onAuthResult}
          onPhone={() => {
            setPendingAccount(null)
            go('phone')
          }}
          onBack={() => go('intro')}
        />
      )}

      {state.screen === 'phone' && (
        <Step
          screen="phone"
          title={getPendingAccount() ? 'Now, your WhatsApp number' : "What's your WhatsApp number?"}
          body={
            getPendingAccount()
              ? "Wingman works on WhatsApp. I'll text you a 6-digit code there to connect it to your account."
              : "I'll text you a 6-digit code there to make sure it's you."
          }
          back={() => go('auth')}
          next={async () => {
            const err = await sendCode()
            if (err) toast(err)
            else go('verify')
          }}
          nextLabel="Send my code"
          nextDisabled={!phoneValid || busy}
        >
          <div className="wg-field">
            <select aria-label={t('Country code')} value={state.cc} onChange={(e) => set('cc', e.target.value)}>
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
              value={state.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </div>
          <p className="wg-note">
            <IconShield size={16} />
            {t('Your number is only used for our WhatsApp chat. No calls, no spam, ever.')}
          </p>
        </Step>
      )}

      {state.screen === 'verify' && (
        <Step
          screen="verify"
          title="Enter your code"
          body={t('Sent on WhatsApp to {phone}.', { phone: fullPhone })}
          back={() => go('phone')}
          next={async () => {
            const err = await verifyCode()
            if (err) toast(err)
            else go('name') // always walk the onboarding; fields come prefilled
          }}
          nextDisabled={!codeComplete || busy}
        >
          <div className="wg-code" onPaste={code.onPaste}>
            {state.code.map((d, i) => (
              <input
                key={i}
                ref={(el) => (code.refs.current[i] = el)}
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                aria-label={t('Digit {n}', { n: i + 1 })}
                value={d}
                onChange={(e) => code.onChange(i, e.target.value)}
                onKeyDown={(e) => code.onKeyDown(i, e)}
              />
            ))}
          </div>
          <p className="wg-note">
            {resend.canResend ? (
              <button
                className="wg-btn-text"
                onClick={async () => {
                  resend.restart()
                  const err = await sendCode()
                  toast(err || 'Code re-sent on WhatsApp')
                }}
              >
                {t('Resend code')}
              </button>
            ) : (
              <>{t('Resend available in {seconds}s', { seconds: resend.left })}</>
            )}
          </p>
        </Step>
      )}

      {state.screen === 'name' && (
        <Step
          screen="name"
          title="What should I call you?"
          back={() => go('verify')}
          next={() => go('tz')}
          nextDisabled={!nameValid}
        >
          <div className="wg-field">
            <input
              autoComplete="given-name"
              placeholder={t('Your first name')}
              value={state.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
        </Step>
      )}

      {state.screen === 'tz' && (
        <Step
          screen="tz"
          title="Where do your days run?"
          body="I detected your timezone. Correct it if I got it wrong."
          back={() => go('name')}
          next={() => go('rhythm')}
        >
          <div className="wg-options">
            {(ZONES.includes(state.tz) ? ZONES : [state.tz, ...ZONES]).map((z) => (
              <button key={z} className={`wg-option wg-card-line ${state.tz === z ? 'on' : ''}`} onClick={() => set('tz', z)}>
                <span className="tx">
                  <strong>{z.replace('_', ' ')}</strong>
                </span>
                <span className="mark">
                  <IconCheck size={14} />
                </span>
              </button>
            ))}
          </div>
        </Step>
      )}

      {state.screen === 'rhythm' && (
        <Step
          screen="rhythm"
          title="Shape your day"
          body="I plan around your working hours and check in at the times you pick."
          back={() => go('tz')}
          next={() => go('proactivity')}
        >
          <div className="wg-group wg-card-line">
            {(
              [
                ['brief', 'Morning briefing', 'Your day, before it starts', <IconSun size={20} variant="duotone" key="b" />, 'peach'],
                ['start', 'Workday starts', undefined, <IconClock size={20} variant="duotone" key="s" />, 'mint'],
                ['end', 'Workday ends', undefined, <IconClock size={20} variant="duotone" key="e" />, 'lavender'],
                ['wrap', 'Evening wrap-up', 'A calm close to the day', <IconBell size={20} variant="duotone" key="w" />, ''],
              ] as const
            ).map(([key, label, hint, icon, tone]) => (
              <label className="wg-row" key={key}>
                <span className={`wg-glyph ${tone}`} style={{ width: 38, height: 38, margin: 0 }}>
                  {icon}
                </span>
                <span className="tx">
                  <strong>{t(label)}</strong>
                  {hint && <span>{t(hint)}</span>}
                </span>
                <input
                  type="time"
                  value={state.times[key]}
                  onChange={(e) => set('times', { ...state.times, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </Step>
      )}

      {state.screen === 'proactivity' && (
        <Step
          screen="proactivity"
          title="How proactive should I be?"
          body="You can change this anytime in Settings."
          back={() => go('rhythm')}
          next={() => go('skills')}
        >
          <div className="wg-options">
            {PROACTIVITY.map((p) => (
              <button
                key={p.value}
                className={`wg-option wg-card-line ${state.proactivity === p.value ? 'on' : ''}`}
                onClick={() => set('proactivity', p.value)}
              >
                <span className="tx">
                  <strong>{t(p.value)}</strong>
                  <span>{t(p.blurbA)}</span>
                </span>
                <span className="mark">
                  <IconCheck size={14} />
                </span>
              </button>
            ))}
          </div>
        </Step>
      )}

      {state.screen === 'skills' && (
        <Step
          screen="skills"
          title="Pick my skills"
          body="Everything is on to start. Switch off what you don't need."
          back={() => go('proactivity')}
          next={() => go('personality')}
        >
          <div className="wg-options">
            {SKILLS.map((s) => (
              <button
                key={s.name}
                className={`wg-option wg-card-line wg-option--switch ${state.skills.includes(s.name) ? 'on' : ''}`}
                onClick={() => toggleSkill(s.name)}
              >
                <span className={`ic ${SKILL_TONES[s.name]}`}>
                  <Icon name={SKILL_ICONS[s.name]} size={20} variant="duotone" />
                </span>
                <span className="tx">
                  <strong>{t(s.name)}</strong>
                  <span>{t(s.blurb)}</span>
                </span>
                <Switch on={state.skills.includes(s.name)} />
              </button>
            ))}
          </div>
        </Step>
      )}

      {state.screen === 'personality' && (
        <Step
          screen="personality"
          title="How should I sound?"
          back={() => go('skills')}
          next={() => go('interests')}
        >
          <div className="wg-options">
            {TONES.map((tn) => (
              <button key={tn.value} className={`wg-option wg-card-line ${state.tone === tn.value ? 'on' : ''}`} onClick={() => set('tone', tn.value)}>
                <span className="tx">
                  <strong>{t(tn.value)}</strong>
                  <span>{t(tn.blurb)}</span>
                </span>
                <span className="mark">
                  <IconCheck size={14} />
                </span>
              </button>
            ))}
          </div>
          <div className="wg-seg" style={{ marginTop: 'var(--space-16)' }}>
            {(['Concise', 'Detailed'] as const).map((d) => (
              <button key={d} className={state.detail === d ? 'on' : ''} onClick={() => set('detail', d)}>
                {t(d)}
              </button>
            ))}
          </div>
          <div className="wg-preview wg-card-line">
            <div className="cap">{t("How I'll sound")}</div>
            <p>{t(preview)}</p>
          </div>
        </Step>
      )}

      {}

      {state.screen === 'interests' && (
        <Step
          screen="interests"
          title="What should I keep an eye on?"
          body="I'll fold a short news brief into your mornings, built from the topics you pick."
          back={() => go('personality')}
          next={() => go('places')}
          skip={() => go('places')}
        >
          <div className="wg-options">
            {INTERESTS.map((it) => (
              <button
                key={it.key}
                className={`wg-option wg-card-line wg-option--switch ${state.interests.includes(it.key) ? 'on' : ''}`}
                onClick={() => toggleInterest(it.key)}
              >
                <span className={`ic ${it.tone}`}>
                  <Icon name={it.icon} size={20} variant="duotone" />
                </span>
                <span className="tx">
                  <strong>{t(it.name)}</strong>
                </span>
                <Switch on={state.interests.includes(it.key)} />
              </button>
            ))}
          </div>
        </Step>
      )}

      {state.screen === 'places' && (
        <Step
          screen="places"
          title="Where do your days run to?"
          body="Save home and work and I'll watch the traffic, then tell you when to leave."
          back={() => go('interests')}
          next={() => go('health')}
          skip={() => go('health')}
        >
          <div style={{ display: 'grid', gap: 'var(--space-12)' }}>
            <div className="wg-field">
              <input
                placeholder={t('Home - area or address')}
                value={state.places.home}
                onChange={(e) => set('places', { ...state.places, home: e.target.value })}
              />
            </div>
            <button
              type="button"
              className="wg-btn-text"
              style={{ justifySelf: 'start' }}
              disabled={locating !== null}
              onClick={() => useMyLocation('home')}
            >
              <Icon name="pin" size={15} variant="duotone" />{' '}
              {locating === 'home' ? t('Getting your location…') : t('Use my current location')}
            </button>
            <div className="wg-field">
              <input
                placeholder={t('Work - area or address')}
                value={state.places.office}
                onChange={(e) => set('places', { ...state.places, office: e.target.value })}
              />
            </div>
            <button
              type="button"
              className="wg-btn-text"
              style={{ justifySelf: 'start' }}
              disabled={locating !== null}
              onClick={() => useMyLocation('office')}
            >
              <Icon name="pin" size={15} variant="duotone" />{' '}
              {locating === 'office' ? t('Getting your location…') : t("I'm at work now — use this location")}
            </button>
          </div>
          <p className="wg-note">
            <IconShield size={16} />
            {t('An area is enough. I only use these to time your commute, never to track where you are.')}
          </p>
        </Step>
      )}

      {state.screen === 'health' && (
        <Step
          screen="health"
          title="Bring your health in?"
          body="Connect Apple Health or Google Fit and I'll shape your day around how you slept and recovered."
          back={() => go('places')}
          next={() => go('business')}
          skip={() => go('business')}
        >
          <div className="wg-options wg-connect">
            <div className="wg-option wg-card-line">
              <span className="ic rose">
                <IconHeart size={20} />
              </span>
              <span className="tx">
                <strong>{t('Apple Health & Google Fit')}</strong>
                <span>{t('Sleep, recovery and movement')}</span>
              </span>
              {state.connected.includes('Apple Health & Google Fit') ? (
                <span className="st done">{t('Connected')}</span>
              ) : (
                <button
                  className="st"
                  onClick={() => toast(t('You can connect Health from Settings once you finish setup.'))}
                >
                  {t('Set up later')}
                </button>
              )}
            </div>
          </div>
          <p className="wg-note">
            <IconShield size={16} />
            {t('I read it to shape your day, never to grade it, and I keep it out of anything I send for you.')}
          </p>
        </Step>
      )}

      {state.screen === 'business' && (
        <Step
          screen="business"
          title="Do you run a business?"
          body="If you do, I can watch your store the way I watch your day: orders, stock, and the calls worth your time."
          back={() => go('health')}
          next={() => go('boundaries')}
          skip={() => go('boundaries')}
        >
          <div className="wg-seg" style={{ marginBottom: state.runsBusiness ? 'var(--space-16)' : 0 }}>
            <button className={state.runsBusiness ? 'on' : ''} onClick={() => set('runsBusiness', true)}>
              {t('Yes, I do')}
            </button>
            <button className={!state.runsBusiness ? 'on' : ''} onClick={() => set('runsBusiness', false)}>
              {t('Not right now')}
            </button>
          </div>
          {state.runsBusiness && (
            <div className="wg-options wg-connect">
              <div className="wg-option wg-card-line">
                <span className="ic">
                  <IconShopifyBrand size={20} />
                </span>
                <span className="tx">
                  <strong>{t('Shopify')}</strong>
                  <span>{t('Orders, stock and store health')}</span>
                </span>
                {state.connected.includes('Shopify') ? (
                  <span className="st done">{t('Connected')}</span>
                ) : (
                  <button
                    className="st"
                    onClick={() => toast(t('You can connect Shopify from Settings once you finish setup.'))}
                  >
                    {t('Set up later')}
                  </button>
                )}
              </div>
              <div className="wg-option wg-card-line">
                <span className="ic blue">
                  <Icon name="mail" size={20} variant="duotone" />
                </span>
                <span className="tx">
                  <strong>{t('Business email')}</strong>
                  <span>{t('Customer mail from your own inbox')}</span>
                </span>
                <button
                  className="st"
                  onClick={() => toast(t('No problem — connect it anytime from More → Connectors → Business email.'))}
                >
                  {t('Set up later')}
                </button>
              </div>
              <div className="wg-option wg-card-line">
                <span className="ic">
                  <Icon name="globe" size={20} variant="duotone" />
                </span>
                <span className="tx">
                  <strong>{t('Google Analytics')}</strong>
                  <span>{t('Traffic and conversions')}</span>
                </span>
                <span className="st">{t('Coming soon')}</span>
              </div>
            </div>
          )}
        </Step>
      )}

      {state.screen === 'boundaries' && (
        <Step
          screen="boundaries"
          title="What can I do on my own?"
          body="You can change this anytime. Important actions always show you the details first."
          back={() => go('business')}
          next={() => go('ready')}
          nextLabel="Finish"
        >
          <div className="wg-options">
            {AUTONOMY.map((a) => (
              <button
                key={a.value}
                className={`wg-option wg-card-line ${state.autonomy === a.value ? 'on' : ''}`}
                onClick={() => set('autonomy', a.value)}
              >
                <span className="tx">
                  <strong>{t(a.value)}</strong>
                  <span>{t(a.blurb)}</span>
                </span>
                <span className="mark">
                  <IconCheck size={14} />
                </span>
              </button>
            ))}
          </div>
          <div className="wg-group wg-card-line" style={{ marginTop: 'var(--space-16)' }}>
            <label className="wg-row">
              <span className="wg-glyph lavender" style={{ width: 38, height: 38, margin: 0 }}>
                <IconClock size={20} variant="duotone" />
              </span>
              <span className="tx">
                <strong>{t('Quiet from')}</strong>
                <span>{t('I hold anything that is not urgent')}</span>
              </span>
              <input
                type="time"
                value={state.quiet.from}
                onChange={(e) => set('quiet', { ...state.quiet, from: e.target.value })}
              />
            </label>
            <label className="wg-row">
              <span className="wg-glyph mint" style={{ width: 38, height: 38, margin: 0 }}>
                <IconSun size={20} variant="duotone" />
              </span>
              <span className="tx">
                <strong>{t('Back on at')}</strong>
                <span>{t('Mornings pick up as normal')}</span>
              </span>
              <input
                type="time"
                value={state.quiet.to}
                onChange={(e) => set('quiet', { ...state.quiet, to: e.target.value })}
              />
            </label>
          </div>
        </Step>
      )}

      {state.screen === 'ready' && (
        <div className="wg-screen">
          <div className="wg-success">
            <IconCheck size={30} />
          </div>
          <h1 className="wg-h1">{t("You're all set, {name}", { name: state.name.trim() || t('there') })}</h1>
          <p className="wg-body">
            {t(
              'Your first briefing lands on WhatsApp at {time}. Connect your services so I can start watching for you.',
              { time: formatTime(state.times.brief) },
            )}
          </p>
          <div className="wg-content">
            <div className="wg-options wg-connect">
              {(
                [
                  ['Google Calendar', 'Meetings, clashes, day plans', <IconGCalBrand size={20} key="c" />],
                  ['Gmail', 'Urgent mail surfaced, noise filtered', <IconGmailBrand size={18} key="m" />],
                ] as const
              ).map(([name, blurb, icon]) => (
                <div className="wg-option wg-card-line" key={name}>
                  <span className="ic">{icon}</span>
                  <span className="tx">
                    <strong>{name}</strong>
                    <span>{t(blurb)}</span>
                  </span>
                  {state.connected.includes(name) ? (
                    <span className="st done">{t('Connected')}</span>
                  ) : (
                    <button
                      className="st"
                      onClick={() => {
                        openConnect(name)
                        toast(t('Opening {service} — finish there, then come back', { service: name }))
                      }}
                    >
                      {t('Connect')}
                    </button>
                  )}
                </div>
              ))}
              <div className="wg-option wg-card-line">
                <span className="ic">
                  <IconHeart size={20} />
                </span>
                <span className="tx">
                  <strong>{t('Health data')}</strong>
                  <span>{t('Sleep, readiness, calm days')}</span>
                </span>
                {state.connected.includes('Apple Health & Google Fit') ? (
                  <span className="st done">{t('Connected')}</span>
                ) : (
                  <button
                    className="st"
                    onClick={() => toast(t('You can connect Health from Settings once you finish setup.'))}
                  >
                    {t('Set up later')}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="wg-actions" style={{ flexDirection: 'column', gap: 'var(--space-8)' }}>
            <button
              className="wg-btn full"
              disabled={busy}
              onClick={async () => {
                const err = await finish()
                if (err) {
                  toast(err)
                  return
                }
                onDone()
              }}
            >
              {t('Go to Wingman')}
            </button>
            <button
              className="wg-btn-text"
              disabled={busy}
              onClick={async () => {
                const err = await finish()
                if (err) {
                  toast(err)
                  return
                }
                onDone()
              }}
            >
              {t("I'll connect these later")}
            </button>
          </div>
        </div>
      )}

      {}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 24,
          transform: `translateX(-50%) translateY(${show ? '0px' : 'var(--toast-distance)'}) scale(${
            show ? '1' : 'var(--toast-scale)'
          })`,
          opacity: show ? 1 : 0,
          filter: show ? 'blur(0)' : 'blur(var(--toast-blur))',
          transition: [
            `opacity var(--toast-${show ? 'open' : 'close'}) var(--toast-ease)`,
            `transform var(--toast-${show ? 'open' : 'close'}) var(--toast-ease)`,
            `filter var(--toast-${show ? 'open' : 'close'}) var(--toast-ease)`,
          ].join(', '),
          background: 'var(--ink)',
          color: 'var(--on-ink)',
          borderRadius: 'var(--radius-pill)',
          padding: 'var(--space-12) var(--space-16)',
          fontSize: 13.5,
          pointerEvents: 'none',
        }}
      >
        {t(msg)}
      </div>
    </div>
  )
}
