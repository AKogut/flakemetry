import { describe, expect, it } from 'vitest'

import { createRateLimiter } from '../rate-limit'

describe('createRateLimiter', () => {
  it('allows up to max requests per window then rejects', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1_000, now: () => 1_000 })

    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(true)
    const blocked = limiter.check('a')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('resets the counter when the window elapses', () => {
    let clock = 1_000
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => clock })

    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
    clock += 1_000
    expect(limiter.check('a').allowed).toBe(true)
  })

  it('evicts stale buckets so keys do not accumulate forever', () => {
    let clock = 1_000
    const limiter = createRateLimiter({ max: 5, windowMs: 1_000, now: () => clock })

    for (let i = 0; i < 50; i += 1) limiter.check(`key-${i}`)
    expect(limiter.size()).toBe(50)

    clock += 5_000
    limiter.check('fresh')
    expect(limiter.size()).toBe(1)
  })

  it('tracks keys independently', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => 0 })
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('b').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
  })
})
