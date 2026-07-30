import { describe, expect, it, vi } from 'vitest'

import { formatDiscord } from '../discord'
import type { EmailSender } from '../email'
import type { NotificationEvent } from '../message'
import { type Channel, createDispatcher, type NotificationSender } from '../notifier'
import { formatSlack } from '../slack'

const flakyEvent: NotificationEvent = {
  type: 'flaky_detected',
  projectId: 'p1',
  heading: 'New flaky test detected',
  summary: '`auth › logs in` is now flaky (score 0.82)',
  url: 'https://flakemetry.example.com/p1/tests/t1',
  fields: [
    { label: 'Suite', value: 'auth' },
    { label: 'Score', value: '0.82' },
  ],
  dedupeKey: 'flaky_detected:t1',
}

const slackChannel: Channel = {
  id: 'slack-1',
  kind: 'slack',
  webhookUrl: 'https://hooks.slack.test/abc',
  types: ['flaky_detected', 'rca_ready'],
}

describe('formatSlack', () => {
  it('builds an actionable message with a dashboard link button', () => {
    const payload = formatSlack(flakyEvent)
    expect(payload.text).toContain('New flaky test detected')
    const json = JSON.stringify(payload.blocks)
    expect(json).toContain('logs in')
    expect(json).toContain('View in Flakemetry')
    expect(json).toContain(flakyEvent.url)
  })
})

describe('formatDiscord', () => {
  it('embeds the summary, link and fields', () => {
    const payload = formatDiscord(flakyEvent)
    const embed = payload.embeds[0] as { title: string; url: string; fields: unknown[] }
    expect(embed.title).toBe('New flaky test detected')
    expect(embed.url).toBe(flakyEvent.url)
    expect(embed.fields).toHaveLength(2)
  })
})

describe('createDispatcher', () => {
  it('routes an event only to channels subscribed to its type', async () => {
    const send: NotificationSender = vi.fn(async () => ({ ok: true, status: 200 }))
    const quarantineOnly: Channel = {
      id: 'slack-2',
      kind: 'slack',
      webhookUrl: 'https://hooks.slack.test/xyz',
      types: ['quarantine_changed'],
    }
    const dispatcher = createDispatcher({ channels: [slackChannel, quarantineOnly], send })

    await dispatcher.dispatch(flakyEvent)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(slackChannel.webhookUrl, expect.anything())
  })

  it('also dispatches to per-event dynamic channels', async () => {
    const send: NotificationSender = vi.fn(async () => ({ ok: true, status: 200 }))
    const dynamic: Channel = {
      id: 'db:1',
      kind: 'discord',
      webhookUrl: 'https://discord.test/hook',
      types: ['flaky_detected'],
    }
    const dispatcher = createDispatcher({
      channels: [slackChannel],
      channelsFor: async () => [dynamic],
      send,
    })

    await dispatcher.dispatch(flakyEvent)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(dynamic.webhookUrl, expect.anything())
  })

  it('suppresses duplicate events within the dedupe window and re-sends after it', async () => {
    const send: NotificationSender = vi.fn(async () => ({ ok: true, status: 200 }))
    let clock = 1_000
    const dispatcher = createDispatcher({
      channels: [slackChannel],
      send,
      now: () => clock,
      dedupeWindowMs: 10_000,
    })

    await dispatcher.dispatch(flakyEvent)
    await dispatcher.dispatch(flakyEvent)
    expect(send).toHaveBeenCalledTimes(1)

    clock += 20_000
    await dispatcher.dispatch(flakyEvent)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not consume the dedupe slot when delivery fails, so it retries next time', async () => {
    let attempt = 0
    const send: NotificationSender = vi.fn(async () => {
      attempt += 1
      return attempt === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }
    })
    const errors: unknown[] = []
    const dispatcher = createDispatcher({
      channels: [slackChannel],
      send,
      onError: (error) => errors.push(error),
    })

    await dispatcher.dispatch(flakyEvent)
    await dispatcher.dispatch(flakyEvent)

    expect(send).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
  })

  it('routes an email channel to the email sender with a formatted message', async () => {
    const send: NotificationSender = vi.fn(async () => ({ ok: true, status: 200 }))
    const sendEmail: EmailSender = vi.fn(async () => ({ ok: true, status: 200 }))
    const emailChannel: Channel = {
      id: 'email-1',
      kind: 'email',
      webhookUrl: 'alerts@acme.com',
      types: ['flaky_detected'],
    }
    const dispatcher = createDispatcher({ channels: [emailChannel], send, sendEmail })

    await dispatcher.dispatch(flakyEvent)

    expect(send).not.toHaveBeenCalled()
    expect(sendEmail).toHaveBeenCalledWith(
      'alerts@acme.com',
      expect.objectContaining({ subject: expect.stringContaining('New flaky test detected') }),
    )
  })

  it('reports an error when an email channel has no configured sender', async () => {
    const errors: unknown[] = []
    const emailChannel: Channel = {
      id: 'email-1',
      kind: 'email',
      webhookUrl: 'alerts@acme.com',
      types: ['flaky_detected'],
    }
    const dispatcher = createDispatcher({
      channels: [emailChannel],
      onError: (error) => errors.push(error),
    })

    await dispatcher.dispatch(flakyEvent)

    expect(errors).toHaveLength(1)
  })
})
