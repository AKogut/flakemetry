import { describe, expect, it, vi } from 'vitest'

import {
  deliverWebhook,
  DELIVERY_HEADER,
  EVENT_HEADER,
  generateWebhookSecret,
  type Lookup,
  resolvesToPublicAddress,
  SIGNATURE_HEADER,
  signWebhook,
  verifyWebhook,
} from '../outbound'

const SECRET = 'whsec_test'
const publicLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

const okFetch = () =>
  vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch

const base = {
  url: 'https://hooks.example.com/x',
  secret: SECRET,
  event: 'flaky.detected',
  payload: { a: 1 },
  deliveryId: 'd1',
  lookup: publicLookup,
}

describe('signing', () => {
  it('binds the timestamp into the signature', () => {
    // A signature over the body alone can be replayed forever; with the timestamp inside it,
    // a receiver that checks the age gets replay protection.
    expect(signWebhook(SECRET, 1, 'body')).not.toBe(signWebhook(SECRET, 2, 'body'))
  })

  it('changes when the body changes', () => {
    expect(signWebhook(SECRET, 1, 'a')).not.toBe(signWebhook(SECRET, 1, 'b'))
  })

  it('verifies a genuine signature and rejects a forged one', () => {
    const signature = signWebhook(SECRET, 10, 'body')

    expect(verifyWebhook(SECRET, 10, 'body', signature)).toBe(true)
    expect(verifyWebhook('whsec_other', 10, 'body', signature)).toBe(false)
    expect(verifyWebhook(SECRET, 11, 'body', signature)).toBe(false)
    expect(verifyWebhook(SECRET, 10, 'body', 'short')).toBe(false)
  })

  it('generates secrets that differ', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret())
    expect(generateWebhookSecret().length).toBeGreaterThan(40)
  })
})

describe('resolvesToPublicAddress', () => {
  it('rejects a public name that resolves to link-local', async () => {
    // The standard way a webhook feature becomes an SSRF: the hostname looks fine, the
    // address is the cloud metadata service.
    const lookup: Lookup = async () => [{ address: '169.254.169.254', family: 4 }]

    expect(await resolvesToPublicAddress('metadata.evil.test', lookup)).toBe(false)
  })

  it('rejects when any answer is private, not only the first', async () => {
    const lookup: Lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]

    // Otherwise which address gets used is a coin toss.
    expect(await resolvesToPublicAddress('split.evil.test', lookup)).toBe(false)
  })

  it('rejects private ipv6 and mapped ipv4', async () => {
    expect(await resolvesToPublicAddress('a', async () => [{ address: '::1', family: 6 }])).toBe(
      false,
    )
    expect(
      await resolvesToPublicAddress('a', async () => [{ address: 'fd00::1', family: 6 }]),
    ).toBe(false)
    expect(
      await resolvesToPublicAddress('a', async () => [{ address: '::ffff:127.0.0.1', family: 6 }]),
    ).toBe(false)
  })

  it('rejects a name that does not resolve at all', async () => {
    expect(await resolvesToPublicAddress('a', async () => [])).toBe(false)
    expect(
      await resolvesToPublicAddress('a', async () => {
        throw new Error('ENOTFOUND')
      }),
    ).toBe(false)
  })

  it('accepts a public address', async () => {
    expect(await resolvesToPublicAddress('example.com', publicLookup)).toBe(true)
  })
})

describe('deliverWebhook', () => {
  it('signs the request and names the event', async () => {
    const fetchImpl = okFetch()

    await deliverWebhook({ ...base, fetchImpl, now: () => 1_000_000 })

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const headers = init.headers as Record<string, string>
    expect(headers[EVENT_HEADER]).toBe('flaky.detected')
    expect(headers[DELIVERY_HEADER]).toBe('d1')
    expect(headers[SIGNATURE_HEADER]).toMatch(/^t=1000,v1=[0-9a-f]{64}$/)
  })

  it('produces a signature the receiver can verify over what was sent', async () => {
    const fetchImpl = okFetch()

    await deliverWebhook({ ...base, fetchImpl, now: () => 5_000 })

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    const headers = init.headers as Record<string, string>
    const signature = headers[SIGNATURE_HEADER]!.split('v1=')[1]!
    expect(verifyWebhook(SECRET, 5, init.body as string, signature)).toBe(true)
  })

  it('refuses http and private hostnames outright', async () => {
    const fetchImpl = okFetch()

    const insecure = await deliverWebhook({ ...base, url: 'http://example.com/x', fetchImpl })
    const internal = await deliverWebhook({ ...base, url: 'https://localhost/x', fetchImpl })

    expect(insecure.ok).toBe(false)
    expect(internal.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not send when the hostname resolves privately', async () => {
    const fetchImpl = okFetch()

    const result = await deliverWebhook({
      ...base,
      fetchImpl,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('private')
    // The check has to happen before the request, not after it.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never follows a redirect', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    ) as unknown as typeof fetch

    const result = await deliverWebhook({ ...base, fetchImpl })

    // A 302 to the metadata service would defeat every check above.
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(init.redirect).toBe('manual')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('redirect')
  })

  it('reports a failure without swallowing the status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch

    const result = await deliverWebhook({ ...base, fetchImpl })

    expect(result).toMatchObject({ ok: false, status: 500 })
  })

  it('truncates whatever the receiver echoes back', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x'.repeat(10_000), { status: 400 }),
    ) as unknown as typeof fetch

    const result = await deliverWebhook({ ...base, fetchImpl })

    expect(result.error!.length).toBeLessThanOrEqual(200)
  })

  it('gives up on a receiver that never answers', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch

    const result = await deliverWebhook({ ...base, fetchImpl, timeoutMs: 10 })

    // A hung receiver must not hold the worker.
    expect(result).toMatchObject({ ok: false, error: 'timed out' })
  })

  it('never puts the secret in what it returns', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(SECRET, { status: 400 }),
    ) as unknown as typeof fetch

    const result = await deliverWebhook({ ...base, fetchImpl })

    expect(JSON.stringify({ ...result, error: undefined })).not.toContain(SECRET)
  })
})
