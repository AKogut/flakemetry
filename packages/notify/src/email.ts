import { createTransport, type Transporter } from 'nodemailer'

import type { NotificationEvent } from './message'
import type { SendResult } from './notifier'

export interface EmailMessage {
  subject: string
  text: string
}

export type EmailSender = (to: string, message: EmailMessage) => Promise<SendResult>

export const formatEmail = (event: NotificationEvent): EmailMessage => {
  const lines = [event.summary]
  if (event.fields && event.fields.length > 0) {
    lines.push('', ...event.fields.map((field) => `${field.label}: ${field.value}`))
  }
  if (event.url) lines.push('', event.url)
  return { subject: `[Flakemetry] ${event.heading}`, text: lines.join('\n') }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isEmailAddress = (value: string): boolean => EMAIL_PATTERN.test(value)

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
}

export const parseSmtpConfig = (env: Record<string, string | undefined>): SmtpConfig | null => {
  const host = env.FLAKEMETRY_SMTP_HOST
  const from = env.FLAKEMETRY_SMTP_FROM
  if (!host || !from) return null
  const parsedPort = Number(env.FLAKEMETRY_SMTP_PORT ?? 587)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587
  return {
    host,
    port,
    secure: env.FLAKEMETRY_SMTP_SECURE === 'true' || port === 465,
    user: env.FLAKEMETRY_SMTP_USER,
    pass: env.FLAKEMETRY_SMTP_PASS,
    from,
  }
}

export const createSmtpSender = (config: SmtpConfig): EmailSender => {
  const transport: Transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  })
  return async (to, message) => {
    await transport.sendMail({
      from: config.from,
      to,
      subject: message.subject,
      text: message.text,
    })
    return { ok: true, status: 200 }
  }
}
