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

  it('names a test with no suite properly and sends Discord no empty field', async () => {
    const calls: { body: { embeds: { description: string; fields?: { value: string }[] }[] } }[] =
      []
    global.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      calls.push({ body: JSON.parse((init as { body?: string }).body ?? '{}') })
      return { ok: true, status: 204 } as Response
    }) as unknown as typeof fetch

    const events = createEventBus()
    startNotifications(events, {
      FLAKEMETRY_DISCORD_WEBHOOK: 'https://discord.test/api/webhooks/1',
    })
    events.emit('flaky.detected', {
      testIdentityId: 't1',
      projectId: 'p1',
      suite: '',
      title: 'user can add a product to cart',
      filePath: 'smoke/add-product-to-cart.spec.ts',
      score: 0.9,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const embed = calls[0]!.body.embeds[0]!
    expect(embed.description).toContain('`user can add a product to cart`')
    expect(embed.description).not.toContain('›')
    expect(embed.fields?.every((field) => field.value.length > 0)).toBe(true)
  })

  it('is disabled when no channels are configured', () => {
    const events = createEventBus()
    expect(startNotifications(events, {})).toBe(false)
  })
})
