import { openExternal } from '../native/platform'
import { useEffect, useState } from 'react'
import { SubScreen } from './SubScreen'
import { Icon, IconPlus, IconGmailBrand } from './icons'
import { api, type GoogleAccount } from '../data/api'
import { useProfile } from '../data/store'
import { t } from '../i18n'
import { toast } from '../shell/toast'
import { confirmAction } from '../shell/confirm'
import './app.css'
import './business.css'

// Manage the user's linked Google accounts: reads merge across all of them; the
// PRIMARY account is the one Wingman sends and creates from.
export const GoogleAccounts = () => {
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null)
  const [busy, setBusy] = useState(false)
  const phone = useProfile().phone.replace(/\D/g, '')

  const load = () => {
    void api
      .googleAccounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]))
  }
  useEffect(() => load(), [])
  // Returning from the Google OAuth tab → refresh so a newly-added account shows.
  useEffect(() => {
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const addAccount = () => {
    if (!phone) {
      toast(t('Sign in first.'))
      return
    }
    openExternal(api.googleConnectUrl(phone))
    toast(t('Pick the account to add, then come back here.'))
  }

  const makePrimary = async (a: GoogleAccount) => {
    if (a.is_primary || busy) return
    setBusy(true)
    try {
      const r = await api.setPrimaryGoogleAccount(a.id)
      setAccounts(r.accounts)
      toast(t('{email} is now primary.', { email: a.email || t('That account') }), 'checkCircle')
    } catch {
      toast(t('Could not switch the primary account right now.'), 'alert')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (a: GoogleAccount) => {
    const ok = await confirmAction({
      title: t('Disconnect {email}?', { email: a.email || t('this account') }),
      body: t("I'll stop reading its mail and calendar straight away. You can reconnect any time."),
      confirmLabel: t('Disconnect it'),
      cancelLabel: t('Keep it connected'),
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await api.disconnectGoogleAccount(a.id)
      setAccounts(r.accounts)
      toast(t('Account disconnected.'), 'check')
    } catch {
      toast(t('Could not disconnect right now.'), 'alert')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SubScreen title="Google accounts" back="more" className="wg-mod" feedback="header">
      <div className="wg-bc__summary wg-card-line">
        <Icon name="mail" size={18} variant="duotone" />
        <p>
          {t(
            'Connect more than one Google account and I merge their mail and calendar into one view. The primary account is the one I send and create from.',
          )}
        </p>
      </div>

      {accounts === null ? (
        <p className="wg-note">{t('Loading…')}</p>
      ) : accounts.length === 0 ? (
        <div className="wg-bc__summary wg-card-line">
          <Icon name="shield" size={18} variant="duotone" />
          <p>{t('No Google account connected yet. Add one below.')}</p>
        </div>
      ) : (
        <div className="wg-row-list">
          {accounts.map((a) => (
            <div className="wg-integ wg-card-line" key={a.id}>
              <div className="wg-integ__top">
                <span className="wg-chip blue sm">
                  <IconGmailBrand size={18} />
                </span>
                <div className="wg-integ__tx">
                  <div className="wg-integ__name" dir="ltr">
                    {a.email || t('Google account')}
                  </div>
                  <div className="wg-integ__sync">
                    {a.is_primary ? t('Primary — I send & create from here') : t('Reading mail & calendar')}
                  </div>
                </div>
                {a.is_primary && <span className="wg-mstatus go">{t('Primary')}</span>}
              </div>
              <div className="wg-integ__foot">
                {!a.is_primary && (
                  <button className="wg-link" disabled={busy} onClick={() => makePrimary(a)}>
                    {t('Make primary')}
                  </button>
                )}
                <button className="wg-link wg-link--end wg-link--danger" disabled={busy} onClick={() => remove(a)}>
                  {t('Disconnect')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button className="wg-btn full" disabled={busy} onClick={addAccount}>
        <IconPlus size={18} /> {t('Add another Google account')}
      </button>

      <p className="wg-footnote">
        {t('Adding an account opens Google so you can pick which one. Come back after and it appears here.')}
      </p>
    </SubScreen>
  )
}
