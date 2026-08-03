import { formatDiscord } from './discord'
import { type EmailSender, formatEmail } from './email'
import type { NotificationEvent, NotificationType } from './message'
import { formatSlack } from './slack'
import { assertSafeWebhookUrl, WEBHOOK_TIMEOUT_MS } from './webhook'

export type ChannelKind = 'slack' | 'discord' | 'email'

export interface Channel {
  id: string
  kind: ChannelKind
  webhookUrl: string
  types: readonly NotificationType[]
}

export interface SendResult {
  ok: boolean
  status: number
}

export type NotificationSender = (url: string, payload: unknown) => Promise<SendResult>

export interface DispatcherOptions {
  channels: readonly Channel[]
  channelsFor?: (event: NotificationEvent) => Promise<readonly Channel[]>
  send?: NotificationSender
  sendEmail?: EmailSender
  now?: () => number
  dedupeWindowMs?: number
  onError?: (error: unknown) => void
}

export interface Dispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>
}

const defaultSender: NotificationSender = async (url, payload) => {
  assertSafeWebhookUrl(url)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  })
  return { ok: response.ok, status: response.status }
}

const format = (channel: Channel, event: NotificationEvent): unknown =>
  channel.kind === 'slack' ? formatSlack(event) : formatDiscord(event)

const defaultEmailSender: EmailSender = async () => {
  throw new Error('notify: email channel requires SMTP configuration')
}

export const createDispatcher = (options: DispatcherOptions): Dispatcher => {
  const send = options.send ?? defaultSender
  const sendEmail = options.sendEmail ?? defaultEmailSender
  const now = options.now ?? (() => Date.now())
  const window = options.dedupeWindowMs ?? 6 * 60 * 60 * 1000
  const onError = options.onError ?? (() => undefined)
  const lastSentAt = new Map<string, number>()

  const prune = (at: number): void => {
    for (const [key, sentAt] of lastSentAt) {
      if (at - sentAt >= window) lastSentAt.delete(key)
    }
  }

  return {
    async dispatch(event) {
      // Callers fire this without awaiting, so a rejection here would surface as an
      // unhandled rejection and take the process down. Loading channels can fail —
      // it reads the database — so nothing in here is allowed to escape.
      try {
        await dispatchOrThrow(event)
      } catch (error) {
        onError(error)
      }
    },
  }

  async function dispatchOrThrow(event: NotificationEvent): Promise<void> {
    prune(now())
    const dynamic = options.channelsFor ? await options.channelsFor(event) : []
    const targets = [...options.channels, ...dynamic].filter((channel) =>
      channel.types.includes(event.type),
    )
    for (const channel of targets) {
      const key = `${channel.id}:${event.dedupeKey}`
      const previous = lastSentAt.get(key)
      if (previous != null && now() - previous < window) continue
      lastSentAt.set(key, now())
      try {
        const result =
          channel.kind === 'email'
            ? await sendEmail(channel.webhookUrl, formatEmail(event))
            : await send(channel.webhookUrl, format(channel, event))
        if (!result.ok) {
          lastSentAt.delete(key)
          onError(
            new Error(`notify: ${channel.kind} channel ${channel.id} returned ${result.status}`),
          )
        }
      } catch (error) {
        lastSentAt.delete(key)
        onError(error)
      }
    }
  }
}
