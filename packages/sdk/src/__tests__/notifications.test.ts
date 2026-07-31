import { describe, expect, it, vi } from 'vitest'

import { findNotificationRouting, uploadNotificationRouting } from '../notifications'

const YML = `
project: acme/web
notifications:
  channels:
    - kind: slack
      target: https://hooks.slack.com/services/T/B/x
      events: [flaky_detected, suite_regressed]
    - kind: email
      target: alerts@acme.com
`

describe('findNotificationRouting', () => {
  it('loads and validates the notifications section from flakemetry.yml', () => {
    const exists = (path: string) => path === '/repo/flakemetry.yml'
    const readFile = (path: string) => (path === '/repo/flakemetry.yml' ? YML : '')
    const routing = findNotificationRouting('/repo/apps/web', { exists, readFile })

    expect(routing?.channels).toHaveLength(2)
    expect(routing?.channels[0]).toMatchObject({
      kind: 'slack',
      events: ['flaky_detected', 'suite_regressed'],
    })
    expect(routing?.channels[1]).toMatchObject({ kind: 'email', target: 'alerts@acme.com' })
  })

  it('returns null when no config file is found', () => {
    expect(findNotificationRouting('/repo', { exists: () => false })).toBeNull()
  })

  it('throws on an invalid channel kind', () => {
    const exists = () => true
    const readFile = () => 'notifications:\n  channels:\n    - kind: sms\n      target: x\n'
    expect(() => findNotificationRouting('/repo', { exists, readFile })).toThrow()
  })
})

describe('uploadNotificationRouting', () => {
  it('PUTs the routing to the notifications endpoint with the token', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const ok = await uploadNotificationRouting({
      endpoint: 'https://api.test/',
      token: 'tok',
      routing: { channels: [{ kind: 'email', target: 'a@b.com', events: [] }] },
      fetchImpl,
    })

    expect(ok).toBe(true)
    expect(calls[0]?.url).toBe('https://api.test/v1/notifications/routing')
    expect(calls[0]?.init.method).toBe('PUT')
    expect(
      String(
        calls[0]?.init.headers && (calls[0]!.init.headers as Record<string, string>).authorization,
      ),
    ).toBe('Bearer tok')
  })
})
