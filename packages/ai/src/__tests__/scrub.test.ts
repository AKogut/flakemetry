import { describe, expect, it } from 'vitest'

import { scrubError, scrubText } from '../scrub'

describe('scrubText', () => {
  it('redacts flakemetry and provider tokens', () => {
    expect(scrubText('token fmk_0123456789abcdef0123456789abcdef')).toContain('[REDACTED_TOKEN]')
    expect(scrubText('key sk-ant-api03-abcdef0123456789ABCDEF')).toContain('[REDACTED_TOKEN]')
    expect(scrubText('OpenAI sk-abcdefghijklmnop0123456789')).toContain('[REDACTED_TOKEN]')
    expect(scrubText('ghp_abcdefghijklmnop0123456789')).toContain('[REDACTED_TOKEN]')
  })

  it('redacts an AWS access key id', () => {
    expect(scrubText('AKIAIOSFODNN7EXAMPLE failed')).toBe('[REDACTED_AWS_KEY] failed')
  })

  it('redacts a JWT and a bearer token', () => {
    expect(scrubText('jwt eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM')).toContain('[REDACTED_JWT]')
    expect(scrubText('Authorization: Bearer abcdef1234567890')).toContain('Bearer [REDACTED_TOKEN]')
  })

  it('redacts key=value secrets while keeping the key', () => {
    expect(scrubText('password="hunter2longsecret"')).toBe('password="[REDACTED]"')
    expect(scrubText('api_key=abc123secretvalue')).toBe('api_key=[REDACTED]')
    expect(scrubText('DB_TOKEN: s3cr3t-value')).toContain('[REDACTED]')
  })

  it('redacts credentials embedded in a URL', () => {
    expect(scrubText('postgres://user:p4ss@db:5432/app')).toBe('postgres://[REDACTED]@db:5432/app')
  })

  it('redacts emails and IPv4 addresses', () => {
    expect(scrubText('contact andrii@example.com now')).toBe('contact [REDACTED_EMAIL] now')
    expect(scrubText('connect 192.168.10.24 timed out')).toBe('connect [REDACTED_IP] timed out')
  })

  it('redacts a home directory username from a path', () => {
    expect(scrubText('at /Users/andrii/project/app.ts:10')).toBe(
      'at /Users/[REDACTED]/project/app.ts:10',
    )
    expect(scrubText('at /home/deploy/svc/main.js')).toBe('at /home/[REDACTED]/svc/main.js')
    expect(scrubText('C:\\Users\\Andrii\\repo\\a.ts')).toBe('C:\\Users\\[REDACTED]\\repo\\a.ts')
  })

  it('leaves ordinary error text and version numbers alone', () => {
    const text = 'Timeout 30000ms exceeded in v1.2.3 at login.spec.ts'
    expect(scrubText(text)).toBe(text)
  })
})

describe('scrubError', () => {
  it('scrubs message and stack, preserves type and null stack', () => {
    const scrubbed = scrubError({
      type: 'AuthError',
      message: 'login failed for andrii@example.com',
      stack: 'at /Users/andrii/a.ts with token fmk_0123456789abcdef0123456789abcdef',
    })
    expect(scrubbed.type).toBe('AuthError')
    expect(scrubbed.message).toBe('login failed for [REDACTED_EMAIL]')
    expect(scrubbed.stack).toContain('/Users/[REDACTED]/')
    expect(scrubbed.stack).toContain('[REDACTED_TOKEN]')
    expect(scrubError({ message: 'x', stack: null }).stack).toBeNull()
  })
})
