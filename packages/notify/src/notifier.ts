import { formatDiscord } from './discord'
import type { NotificationEvent, NotificationType } from './message'
import { formatSlack } from './slack'

export type ChannelKind = 'slack' | 'discord'

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
  now?: () => number
  dedupeWindowMs?: number
  onError?: (error: unknown) => void
}

export interface Dispatcher {
  dispatch: (event: NotificationEvent) => Promise<void>
}

const defaultSender: NotificationSender = async (url, payload) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { ok: response.ok, status: response.status }
}

const format = (channel: Channel, event: NotificationEvent): unknown =>
  channel.kind === 'slack' ? formatSlack(event) : formatDiscord(event)

export const createDispatcher = (options: DispatcherOptions): Dispatcher => {
  const send = options.send ?? defaultSender
  const now = options.now ?? (() => Date.now())
  const window = options.dedupeWindowMs ?? 6 * 60 * 60 * 1000
  const onError = options.onError ?? (() => undefined)
  const lastSentAt = new Map<string, number>()

  return {
    async dispatch(event) {
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
          const result = await send(channel.webhookUrl, format(channel, event))
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
    },
  }
}
