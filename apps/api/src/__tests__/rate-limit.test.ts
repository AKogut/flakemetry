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

  it('tracks keys independently', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1_000, now: () => 0 })
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('b').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
  })
})
