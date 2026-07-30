import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../events'
import { startNotifications } from '../notify'

describe('startNotifications', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  it('posts a Slack message with a dashboard link when a flaky test is detected', async () => {
    const calls: { url: string; body: unknown }[] = []
    global.fetch = vi.fn(async (url: unknown, init: unknown) => {
      const request = init as { body?: string }
      calls.push({ url: String(url), body: JSON.parse(request.body ?? '{}') })
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch

    const events = createEventBus()
    const enabled = startNotifications(events, {
      FLAKEMETRY_SLACK_WEBHOOK: 'https://hooks.slack.test/abc',
      FLAKEMETRY_DASHBOARD_URL: 'https://flakemetry.example.com',
    })
    expect(enabled).toBe(true)

    events.emit('flaky.detected', {
      testIdentityId: 't1',
      projectId: 'p1',
      title: 'logs in',
      suite: 'auth',
      filePath: 'e2e/login.spec.ts',
      score: 0.82,
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://hooks.slack.test/abc')
    const json = JSON.stringify(calls[0]?.body)
    expect(json).toContain('logs in')
    expect(json).toContain('https://flakemetry.example.com/projects/p1/tests/t1')
  })

  it('routes to Slack and Discord and respects the event filter', async () => {
    const urls: string[] = []
    global.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch

    const events = createEventBus()
    startNotifications(events, {
      FLAKEMETRY_SLACK_WEBHOOK: 'https://slack.test',
      FLAKEMETRY_DISCORD_WEBHOOK: 'https://discord.test',
      FLAKEMETRY_NOTIFY_EVENTS: 'quarantine_changed',
    })

    events.emit('flaky.detected', {
      testIdentityId: 't1',
      projectId: 'p1',
      title: 'x',
      suite: 's',
      filePath: 'f',
      score: 0.8,
    })
    events.emit('quarantine.changed', {
      testIdentityId: 't1',
      projectId: 'p1',
      title: 'x',
      suite: 's',
      quarantined: true,
      reason: 'auto',
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(urls.filter((url) => url === 'https://slack.test')).toHaveLength(1)
    expect(urls.filter((url) => url === 'https://discord.test')).toHaveLength(1)
  })

  it('is disabled when no channels are configured', () => {
    const events = createEventBus()
    expect(startNotifications(events, {})).toBe(false)
  })
})
