export interface RateLimitOptions {
  max: number
  windowMs: number
  now?: () => number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export interface RateLimiter {
  check: (key: string) => RateLimitDecision
}

interface Bucket {
  count: number
  windowStart: number
}

export const createRateLimiter = (options: RateLimitOptions): RateLimiter => {
  const now = options.now ?? (() => Date.now())
  const buckets = new Map<string, Bucket>()

  return {
    check(key: string): RateLimitDecision {
      const at = now()
      const bucket = buckets.get(key)
      if (!bucket || at - bucket.windowStart >= options.windowMs) {
        buckets.set(key, { count: 1, windowStart: at })
        return { allowed: true, remaining: options.max - 1, retryAfterMs: 0 }
      }

      if (bucket.count >= options.max) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: bucket.windowStart + options.windowMs - at,
        }
      }

      bucket.count += 1
      return { allowed: true, remaining: options.max - bucket.count, retryAfterMs: 0 }
    },
  }
}
