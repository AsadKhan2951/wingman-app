import { useCallback, useEffect, useRef, useState } from 'react'
import { MorningPaper } from './onboarding/MorningPaper'
import { FirstLight } from './onboarding/FirstLight'
import { WingGlyph } from './onboarding/WingGlyph'
import { Onboarding } from './app/Onboarding'
import { Welcome, SignIn } from './app/SignIn'
import { AuthCallback } from './app/Auth'
import { Home } from './app/Home'
import { Attention } from './app/Attention'
import { InstantMeeting } from './app/InstantMeeting'
import { Calendar } from './app/Calendar'
import { Email } from './app/Email'
import { Tasks } from './app/Tasks'
import { More } from './app/More'
import { Notifications } from './app/Notifications'
import { Profile } from './app/Profile'
import { ProfileEdit, type FieldKey } from './app/ProfileEdit'
import { SettingsPersonality, type PersonalitySection } from './app/SettingsPersonality'
import { SettingsAppearance } from './app/SettingsAppearance'
import { SettingsLanguage } from './app/SettingsLanguage'
import { SettingsPrivacy } from './app/SettingsPrivacy'
import { NotetakerSettings } from './app/NotetakerSettings'
import { EmailPriorities } from './app/EmailPriorities'
import { Permissions } from './app/Permissions'
import { GoogleAccounts } from './app/GoogleAccounts'
import { SettingsHelp } from './app/SettingsHelp'
import { HelpArticle } from './app/HelpArticle'
import { Memory, BusinessBrain } from './app/Memory'
import { Approvals } from './app/Approvals'
import { AssistantChat } from './app/AssistantChat'
import { Business } from './app/Business'
import { BusinessPerformance } from './app/BusinessPerformance'
import { BusinessIntegrations } from './app/BusinessIntegrations'
import { WebmailSetup } from './app/WebmailSetup'
import { WorkClock } from './app/WorkClock'
import { Meetings } from './app/Meetings'
import { MeetingDetail } from './app/MeetingDetail'
import { MeetingBrief } from './app/MeetingBrief'
import { MeetingSettings } from './app/MeetingSettings'
import { MeetingConsent } from './app/MeetingConsent'
import { MeetingLive } from './app/MeetingLive'
import { MeetingSummary } from './app/MeetingSummary'
import { DailyIntelligence } from './app/DailyIntelligence'
import { DailySummary } from './app/DailySummary'
import { RouteDetail } from './app/RouteDetail'
import { SavedPlaces, PlaceEdit } from './app/SavedPlaces'
import { CommutePrefs } from './app/CommutePrefs'
import { News } from './app/News'
import { NewsStory } from './app/NewsStory'
import { NewsTopics } from './app/NewsTopics'
import { NewsSettings } from './app/NewsSettings'
import { Commerce } from './app/Commerce'
import { Bills } from './app/Bills'
import { Deliveries } from './app/Deliveries'
import { Travel } from './app/Travel'
import { People } from './app/People'
import { Health } from './app/Health'
import { Splash } from './splash/Splash'
import { AppShell } from './shell/AppShell'
import { AppChrome } from './shell/AppChrome'
import { ScreenStack } from './shell/ScreenStack'
import { ApprovalHost } from './app/ApprovalCard'
import { ConnectHost } from './app/ConnectSheet'
import { ConfirmHost } from './shell/confirm'
import { Toaster } from './shell/toast'
import { ComingSoon } from './shell/ComingSoon'
import { TAB_ROUTES } from './shell/TabBar'
import { InstallPrompt } from './pwa/InstallPrompt'
import { OrientationLock } from './pwa/OrientationLock'
import { hasThemeRestarted } from './shell/prefs'
import { useLang } from './i18n'
import { useNavRoute, replaceRoute, type NavDir } from './shell/nav'
import { useSession, completeOnboarding, startFresh } from './data/session'
import { api, isSignedIn, setToken, ApiError } from './data/api'
import { hydrateProfile, resetProfile } from './data/store'
import { clearOnboardingState } from './onboarding/shared'
import { hydrateTasks } from './data/tasks'
import { hydrateConnections } from './data/connections'
import { hydrateEmails } from './data/emails'
import { hydrateCalendar } from './data/day'
import { hydrateHomeStats } from './data/homeStats'
import { hydrateContacts } from './data/contacts'
import { hydrateMeetings } from './data/meetings'
import { hydrateFollowups } from './data/followups'
import { hydratePlaces } from './data/mobility'
import { hydrateBills } from './data/bills'
import { hydrateVitals } from './data/vitals'
import { hydratePeople } from './data/people'
import { hydrateDeliveries } from './data/deliveries'
import { hydrateTravel } from './data/travel'
import { useDragScroll } from './shell/useDragScroll'
import { installTapFeedback } from './shell/feedback'
import './picker.css'

const isTabRoute = (route: string) => (TAB_ROUTES as readonly string[]).includes(route)

const FIELD_KEYS: FieldKey[] = ['name', 'phone', 'email', 'timezone', 'workday', 'briefing', 'wrap']
const isFieldKey = (s: string): s is FieldKey => (FIELD_KEYS as string[]).includes(s)

const PERSONALITY_SECTIONS: PersonalitySection[] = ['proactivity', 'skills']
const isPersonalitySection = (s: string): s is PersonalitySection =>
  (PERSONALITY_SECTIONS as string[]).includes(s)

const Screen = ({ route }: { route: string }) => {
  if (route === 'home') return <Home />
  if (route === 'calendar') return <Calendar />
  if (route === 'email') return <Email />
  if (route === 'tasks') return <Tasks />
  if (route === 'more') return <More />
  if (route === 'home/customize') return <Redirect to="home" />
  if (route === 'attention') return <Attention />
  if (route === 'notifications') return <Notifications />
  if (route === 'profile') return <Profile />
  if (route.startsWith('profile/')) {
    const field = route.slice('profile/'.length)
    if (isFieldKey(field)) return <ProfileEdit field={field} />
  }
  if (route === 'settings/personality') return <SettingsPersonality />
  if (route.startsWith('settings/personality/')) {
    const section = route.slice('settings/personality/'.length)
    if (isPersonalitySection(section)) return <SettingsPersonality section={section} />
  }
  if (route === 'settings/appearance') return <SettingsAppearance />
  if (route === 'settings/language') return <SettingsLanguage />
  if (route === 'settings/privacy') return <SettingsPrivacy />
  if (route === 'settings/notetaker') return <NotetakerSettings />
  if (route === 'settings/email-priorities') return <EmailPriorities />
  if (route === 'settings/permissions') return <Permissions />
  if (route === 'settings/google') return <GoogleAccounts />
  if (route === 'settings/memory') return <Memory />
  if (route === 'settings/help') return <SettingsHelp />
  if (route.startsWith('help/')) return <HelpArticle id={route.slice('help/'.length)} />
  if (route === 'bills') return <Bills />
  if (route === 'deliveries') return <Deliveries />
  if (route === 'travel') return <Travel />
  if (route === 'people') return <People />
  if (route === 'health') return <Health />
  if (route === 'daily-intelligence') return <DailyIntelligence />
  if (route === 'daily-summary') return <DailySummary />
  if (route === 'route') return <RouteDetail />
  if (route.startsWith('route/')) return <RouteDetail routeKey={route.slice('route/'.length)} />
  if (route === 'places') return <SavedPlaces />
  if (route.startsWith('places/')) return <PlaceEdit placeKey={route.slice('places/'.length)} />
  if (route === 'commute') return <CommutePrefs />
  if (route === 'news') return <News />
  if (route === 'news/topics') return <NewsTopics />
  if (route === 'news/settings') return <NewsSettings />
  if (route.startsWith('news/')) return <NewsStory id={route.slice('news/'.length)} />
  if (route === 'approvals') return <Approvals />
  if (route === 'assistant') return <AssistantChat />
  if (route === 'business') return <Business />
  if (route === 'business/performance') return <BusinessPerformance />
  if (route === 'business/integrations') return <BusinessIntegrations />
  if (route === 'business/webmail') return <WebmailSetup />
  if (route === 'settings/work') return <WorkClock />
  if (route === 'business/brain') return <BusinessBrain />
  if (route === 'meetings') return <Meetings />
  if (route === 'meetings/instant') return <InstantMeeting />
  if (route.startsWith('meetings/')) {
    const [id, step] = route.slice('meetings/'.length).split('/')
    if (id) {
      if (!step) return <MeetingDetail id={id} />
      if (step === 'brief') return <MeetingBrief id={id} />
      if (step === 'settings') return <MeetingSettings id={id} />
      if (step === 'consent') return <MeetingConsent id={id} />
      if (step === 'live') return <MeetingLive id={id} />
      if (step === 'summary') return <MeetingSummary id={id} />
    }
  }
  if (route === 'commerce') return <Commerce />
  if (isTabRoute(route)) return <ComingSoon route={route} />
  if (route === 'morning-paper') return <MorningPaper />
  if (route === 'first-light') return <FirstLight />

  if (route === 'concepts')
    return (
      <div className="picker">
        <header>
          <WingGlyph className="mark" />
          <h1>Wingman</h1>
          <p>Archived onboarding concepts, superseded by the current design direction on 2026-07-20.</p>
        </header>
        <nav>
          <a href="#/morning-paper" className="card a">
            <span className="badge">Archived A</span>
            <strong>Morning Paper</strong>
            <span className="desc">Warm cream paper, serif questions, agent chat bubbles, ink-pill CTAs.</span>
          </a>
          <a href="#/first-light" className="card b">
            <span className="badge">Archived B</span>
            <strong>First Light</strong>
            <span className="desc">One night-to-dawn scene, a breathing ambient presence, hairline minimalism.</span>
          </a>
        </nav>
        <footer>
          <a href="#/">Back to the current direction</a>
        </footer>
      </div>
    )

  return <Redirect to="home" />
}

const Redirect = ({ to }: { to: string }) => {
  useEffect(() => {
    replaceRoute(to)
  }, [to])
  return null
}

const OPEN_ROUTES = ['concepts', 'morning-paper', 'first-light']

const Gate = ({ route }: { route: string }) => {
  const { onboarded, signedIn } = useSession()
  if (OPEN_ROUTES.includes(route)) return <Screen route={route} />
  if (route.startsWith('auth-callback')) return <AuthCallback route={route} />
  // Not onboarded yet (brand new, OR verified-but-didn't-finish) → the wizard,
  // even when a token exists. This stops a refresh mid-onboarding from dropping
  // the user into Home with nothing saved.
  if (!onboarded)
    return (
      <Onboarding
        onDone={() => {
          completeOnboarding()
          window.location.hash = '#/home'
        }}
      />
    )
  if (signedIn) return <Screen route={route} />
  return route === 'signin' ? <SignIn /> : <Welcome />
}

const App = () => {
  const { route, dir: arrivedBy } = useNavRoute()
  const { signedIn } = useSession()
  useLang()
  const [splashDone, setSplashDone] = useState(hasThemeRestarted)
  const finishSplash = useCallback(() => setSplashDone(true), [])
  const inApp = isTabRoute(route) && signedIn
  const dragScrollRef = useDragScroll()
  useEffect(() => installTapFeedback(), [])
  // Heal a stale/invalid token on load: if the backend rejects it, clear it so we
  // show a clean login instead of the mock/demo dataset (the "all dummy" symptom).
  useEffect(() => {
    if (!isSignedIn()) return
    void api.authMe().catch((e) => {
      if (e instanceof ApiError && e.status === 401) {
        // Invalid/expired token: clear it + the cached (mock) profile, and reset
        // to a fresh start so no stale "Welcome back, <mock name>" ever shows.
        setToken(null)
        resetProfile()
        clearOnboardingState()
        startFresh()
      }
    })
  }, [])
  // Once signed in, pull the real profile + tasks from the backend.
  useEffect(() => {
    if (signedIn) {
      void hydrateProfile()
      void hydrateTasks()
      void hydrateConnections()
      void hydrateEmails()
      void hydrateCalendar()
      void hydrateHomeStats()
      void hydrateContacts()
      void hydrateMeetings()
      void hydrateFollowups()
      void hydratePlaces()
      void hydrateBills()
      void hydrateVitals()
      void hydratePeople()
      void hydrateDeliveries()
      void hydrateTravel()
    }
  }, [signedIn])

  const from = useRef<string | null>(null)
  const dir: NavDir =
    from.current === null || !signedIn || (isTabRoute(from.current) && isTabRoute(route)) ? 'none' : arrivedBy
  useEffect(() => {
    from.current = route
  }, [route])

  const lastTab = useRef(route)
  useEffect(() => {
    if (inApp) lastTab.current = route
  }, [inApp, route])

  return (
    <AppShell>
      <ScreenStack route={route} dir={dir} stackRef={dragScrollRef} render={(r) => <Gate route={r} />} />
      {signedIn && <AppChrome route={inApp ? route : lastTab.current} open={inApp} />}
      {inApp && splashDone && <InstallPrompt />}
      {}
      <ApprovalHost />
      <ConnectHost />
      <ConfirmHost />
      <Toaster hasTabBar={inApp} />
      {!splashDone && <Splash onDone={finishSplash} />}
      {}
      <OrientationLock />
    </AppShell>
  )
}

export default App
