import { openExternal } from '../native/platform'
import { SetRow, SubScreen } from './SubScreen'
import { IconWhatsapp } from './icons'
import { help as helpSeed } from '../data/mock'
import { localize, t } from '../i18n'
import { openWhatsApp } from '../shell/whatsapp'
import './app.css'

export const SettingsHelp = () => {
  const help = localize(helpSeed)

  return (
    <SubScreen title="Help & support" back="more" className="wg-settings">
      <div className="wg-help wg-card-line">
        <span className="wg-help__mark">
          <IconWhatsapp size={26} />
        </span>
        <div className="wg-help__tx">
          <strong>{t('Just ask me')}</strong>
          <p>{t('Anything about how I work, right in our chat. I answer in seconds.')}</p>
        </div>
        <button className="wg-btn full wa" onClick={() => openWhatsApp()}>
          <IconWhatsapp size={18} /> {t('Open WhatsApp')}
        </button>
      </div>

      <div className="wg-panel-head">
        <h2>{t('Common questions')}</h2>
      </div>
      <div className="wg-set-list wg-card-line">
        {help.questions.map((q) => (
          <SetRow key={q.id} icon={q.icon} tone={q.tone} name={q.q} to={`help/${q.id}`} />
        ))}
      </div>

      <div className="wg-panel-head">
        <h2>{t('Get in touch')}</h2>
      </div>
      <div className="wg-set-list wg-card-line">
        <SetRow
          icon="alert"
          tone="sand"
          name="Report a problem"
          onTap={() => openWhatsApp(t("Something isn't working: "))}
        />
        <SetRow
          icon="chat"
          tone="lavender"
          name="Send feedback"
          onTap={() => openWhatsApp(t('Some feedback for you: '))}
        />
        <SetRow
          icon="mail"
          tone="blue"
          name="Email support"
          value="help@wingman.app"
          onTap={() => openExternal('mailto:help@wingman.app')}
        />
      </div>

      <p className="wg-footnote">{help.version}</p>
    </SubScreen>
  )
}
