import { SubScreen } from './SubScreen'
import { Icon, IconSpark, IconChevronR, ConnectorMark } from './icons'
import { businessCenter as bcSeed, type Connector } from '../data/mock'
import { useConnections, disconnect } from '../data/connections'
import { localize, t } from '../i18n'
import { openConnect } from './ConnectSheet'
import { navigate } from '../shell/nav'
import { confirmAction } from '../shell/confirm'
import { toast } from '../shell/toast'
import './app.css'
import './business.css'

const STATUS: Record<Connector['status'], { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'go' },
  connect: { label: 'Disconnected', tone: 'off' },
  soon: { label: 'Coming soon', tone: 'done' },
}

export const BusinessIntegrations = () => {
  const { items } = useConnections()
  const bc = localize(bcSeed)
  const services = bc.integrations
    .map((key) => items.find((c) => c.key === key))
    .filter((c): c is Connector => !!c)
  const connectedCount = services.filter((c) => c.status === 'connected').length

  const manage = async (c: Connector) => {
    if (c.status === 'soon') return
    if (c.status === 'connect') {
      openConnect(c.key)
      return
    }
    const ok = await confirmAction({
      title: t('Disconnect {service}?', { service: c.name }),
      body: t(
        "I'll stop reading it straight away, and the Business Center parts it feeds go quiet: performance, meeting context and its recommendations.",
      ),
      mark: <ConnectorMark brandKey={c.key} icon={c.icon} tone={c.tone} size={32} rung="lg" />,
      confirmLabel: t('Disconnect it'),
      cancelLabel: t('Keep it connected'),
      destructive: true,
    })
    if (!ok) return
    disconnect(c.key)
    toast(t('{service} disconnected.', { service: c.name }), 'check')
  }

  return (
    <SubScreen title="Connected services" back="business" className="wg-mod" feedback="header">
      <div className="wg-bc__summary wg-card-line">
        <IconSpark size={18} />
        <p>
          {connectedCount > 0
            ? t('{n} services connected. The more I can read, the better the context I bring to your meetings and your day.', {
                n: connectedCount,
              })
            : t('Connect your business tools and I can bring performance insights, meeting context and proactive recommendations. Nothing is connected yet.')}
        </p>
      </div>

      <div className="wg-panel-head">
        <h2>{t('Services')}</h2>
      </div>
      <div className="wg-row-list">
        {services.map((c) => {
          const st = STATUS[c.status]
          return (
            <div className="wg-integ wg-card-line" key={c.key}>
              <div className="wg-integ__top">
                <ConnectorMark brandKey={c.key} icon={c.icon} tone={c.tone} size={24} />
                <div className="wg-integ__tx">
                  <div className="wg-integ__name">{c.name}</div>
                  <div className="wg-integ__sync">{c.status === 'connected' ? t(bc.sync[c.key] ?? '') : ''}</div>
                </div>
                <span className={`wg-mstatus ${st.tone}`}>{t(st.label)}</span>
              </div>
              <p className="wg-integ__reads">
                {t('What I read:')} {c.reads.map((r) => t(r)).join(' · ')}
              </p>
              <div className="wg-integ__foot">
                {c.status !== 'soon' && (
                  <button className="wg-link wg-link--end" onClick={() => manage(c)}>
                    {c.status === 'connected' ? t('Manage connection') : t('Connect')}
                    <IconChevronR size={15} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="wg-panel-head">
        <h2>{t('Business email')}</h2>
      </div>
      <button
        className="wg-integ wg-card-line"
        style={{ width: '100%', textAlign: 'left' }}
        onClick={() => navigate('business/webmail')}
      >
        <div className="wg-integ__top">
          <span className="wg-chip blue sm">
            <Icon name="mail" size={18} variant="duotone" />
          </span>
          <div className="wg-integ__tx">
            <div className="wg-integ__name">{t('Business email (IMAP/SMTP)')}</div>
            <div className="wg-integ__sync">{t('Connect your own inbox — I watch it and draft replies')}</div>
          </div>
          <IconChevronR size={18} />
        </div>
      </button>

      <p className="wg-footnote">
        {t('I only ever read from these. Nothing that spends money or messages a customer happens without a card you approve.')}
      </p>
    </SubScreen>
  )
}
