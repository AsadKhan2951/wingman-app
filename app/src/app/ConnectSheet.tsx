import { openExternal } from '../native/platform'
import { useSyncExternalStore } from 'react'
import { Icon, IconCheckCircle, ConnectorMark } from './icons'
import { useConnections } from '../data/connections'
import { api } from '../data/api'
import { getProfile } from '../data/store'
import { Sheet } from '../shell/Sheet'
import { t } from '../i18n'
import { toast } from '../shell/toast'
import { tapHeader } from '../shell/feedback'
import { navigate } from '../shell/nav'
import './app.css'

let openKey: string | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export const openConnect = (key: string) => {
  openKey = key
  emit()
}

const close = () => {
  openKey = null
  emit()
}

export const ConnectHost = () => {
  const key = useSyncExternalStore(subscribe, () => openKey)
  const { items } = useConnections()
  const pending = items.find((c) => c.key === key)

  const grant = () => {
    if (!pending) return
    tapHeader()
    // Route to the REAL connect flow — never fake a "connected" state. The
    // connector's status then updates from the backend (/me) on the next sync.
    if (pending.key === 'gmail' || pending.key === 'gcal') {
      const phone = (getProfile().phone || '').replace(/\D/g, '')
      close()
      openExternal(api.googleConnectUrl(phone))
      toast(t('Opening Google sign-in — approve access, then come back.'))
      return
    }
    if (pending.key === 'webmail') {
      close()
      navigate('business/webmail')
      return
    }
    // No in-app self-serve flow for this one yet — be honest instead of pretending
    // it's connected.
    close()
    toast(t("{service} isn't connectable in the app yet — I'll let you know when it is.", { service: pending.name }))
  }

  return (
    <Sheet open={!!pending} onClose={close} labelledBy="wm-connect-title">
      {pending && (
        <>
          {}
          <span className="wm-sheet__mark">
            <ConnectorMark brandKey={pending.key} icon={pending.icon} tone={pending.tone} size={32} rung="lg" />
          </span>
          <h2 className="wm-sheet__title centred" id="wm-connect-title">
            {t('Connect {service}', { service: pending.name })}
          </h2>
          <p className="wm-sheet__body-tx centred">{t("Here is everything I'd read. Nothing outside this list.")}</p>
          <ul className="wg-scopes">
            {pending.reads.map((r) => (
              <li key={r}>
                <IconCheckCircle size={16} />
                <span>{t(r)}</span>
              </li>
            ))}
          </ul>
          <p className="wg-scopes__never">
            <Icon name="shield" size={16} variant="duotone" />
            <span>{t(pending.never)}</span>
          </p>
          <div className="wm-sheet__acts">
            <button className="wg-btn full" onClick={grant}>
              {t('Connect {service}', { service: pending.name })}
            </button>
            <button className="wg-btn full quiet" onClick={close}>
              {t('Not now')}
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
