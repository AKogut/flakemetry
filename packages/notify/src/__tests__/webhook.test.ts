import { describe, expect, it } from 'vitest'

import { assertSafeWebhookUrl, isSafeWebhookUrl } from '../webhook'

describe('isSafeWebhookUrl', () => {
  it('accepts public https webhooks', () => {
    expect(isSafeWebhookUrl('https://hooks.slack.com/services/T/B/x')).toBe(true)
    expect(isSafeWebhookUrl('https://discord.com/api/webhooks/1/abc')).toBe(true)
  })

  it('rejects plaintext http', () => {
    expect(isSafeWebhookUrl('http://hooks.slack.com/services/T/B/x')).toBe(false)
  })

  it('rejects loopback, private and link-local hosts', () => {
    for (const url of [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://172.16.9.9/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://svc.internal/hook',
    ]) {
      expect(isSafeWebhookUrl(url)).toBe(false)
    }
  })

  it('rejects malformed input', () => {
    expect(isSafeWebhookUrl('not-a-url')).toBe(false)
    expect(isSafeWebhookUrl('')).toBe(false)
  })

  it('assertSafeWebhookUrl throws on unsafe urls', () => {
    expect(() => assertSafeWebhookUrl('http://10.0.0.1/x')).toThrow()
    expect(() => assertSafeWebhookUrl('https://hooks.slack.com/x')).not.toThrow()
  })
})
