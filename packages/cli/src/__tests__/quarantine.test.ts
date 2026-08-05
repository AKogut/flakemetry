import { describe, expect, it, vi } from 'vitest'

import { describeQuarantine, setQuarantineState } from '../commands/quarantine'

const jsonResponse = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const base = {
  endpoint: 'https://api.test',
  token: 'fmk_x',
  testIdentityId: 'test-1',
  decision: 'quarantined' as const,
}

describe('setQuarantineState', () => {
  it('posts the decision and reads back the new state', async () => {
    const fetchImpl = jsonResponse({ quarantined: true, override: 'quarantined', changed: true })

    const outcome = await setQuarantineState({ ...base, reason: 'known bad', fetchImpl })

    expect(outcome).toMatchObject({ ok: true, quarantined: true, override: 'quarantined' })
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      decision: 'quarantined',
      reason: 'known bad',
    })
  })

  it('explains the missing scope instead of calling the token invalid', async () => {
    const outcome = await setQuarantineState({
      ...base,
      fetchImpl: jsonResponse({ error: 'insufficient_scope' }, 403),
    })

    // Same reasoning as the read scope: telling someone their credential is broken sends
    // them off to rotate one that works perfectly.
    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.hint).toContain('quarantine')
  })

  it('distinguishes a rejected token from a missing scope', async () => {
    const outcome = await setQuarantineState({ ...base, fetchImpl: jsonResponse({}, 401) })

    if (!outcome.ok) expect(outcome.reason).toContain('rejected')
  })

  it('says the test is not here rather than that something went wrong', async () => {
    const outcome = await setQuarantineState({ ...base, fetchImpl: jsonResponse({}, 404) })

    if (!outcome.ok) expect(outcome.reason).toContain('no such test')
  })

  it('escapes a test id rather than pasting it into the path', async () => {
    const fetchImpl = jsonResponse({ quarantined: true })

    await setQuarantineState({ ...base, testIdentityId: 'a/../b', fetchImpl })

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toContain('a%2F..%2Fb')
  })

  it('reports a network failure rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const outcome = await setQuarantineState({ ...base, fetchImpl })

    expect(outcome).toMatchObject({ ok: false, reason: 'ECONNREFUSED' })
  })
})

describe('describeQuarantine', () => {
  it('says the automation will not undo a quarantine', () => {
    expect(
      describeQuarantine({ ok: true, quarantined: true, override: 'quarantined', changed: true }),
    ).toContain('will not release it')
  })

  it('says the automation will not undo a release', () => {
    expect(
      describeQuarantine({ ok: true, quarantined: false, override: 'released', changed: true }),
    ).toContain('will not quarantine it again')
  })

  it('says who is in charge after handing it back', () => {
    // The difference matters: a person who does not know the scorer has resumed will read
    // the next automatic change as their own decision being ignored.
    expect(
      describeQuarantine({ ok: true, quarantined: true, override: null, changed: true }),
    ).toContain('scorer')
  })
})
