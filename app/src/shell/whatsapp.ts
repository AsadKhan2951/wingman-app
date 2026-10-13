import { openExternal } from '../native/platform'
import { channel } from '../data/mock'


const digits = (n: string) => n.replace(/\D/g, '')

export const whatsappLink = (text?: string) => {
  const base = `https://wa.me/${digits(channel.number)}`
  return text ? `${base}?text=${encodeURIComponent(text)}` : base
}

export const openWhatsApp = (text?: string) => {
  openExternal(whatsappLink(text))
}
