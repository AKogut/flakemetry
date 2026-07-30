import { describe, expect, it } from 'vitest'

import { formatEmail, isEmailAddress, parseSmtpConfig } from '../email'
import type { NotificationEvent } from '../message'

const event: NotificationEvent = {
  type: 'flaky_detected',
  projectId: 'p1',
  heading: 'New flaky test detected',
  summary: '`auth › logs in` is now flaky (score 0.82)',
  url: 'https://flakemetry.example.com/p1/tests/t1',
  fields: [
    { label: 'Suite', value: 'auth' },
    { label: 'Score', value: '0.82' },
  ],
  dedupeKey: 'flaky_detected:t1',
}

describe('formatEmail', () => {
  it('builds a subject and a plain-text body with fields and link', () => {
    const message = formatEmail(event)
    expect(message.subject).toBe('[Flakemetry] New flaky test detected')
    expect(message.text).toContain('is now flaky')
    expect(message.text).toContain('Suite: auth')
    expect(message.text).toContain('Score: 0.82')
    expect(message.text).toContain(event.url)
  })
})

describe('isEmailAddress', () => {
  it('accepts a plausible address and rejects junk', () => {
    expect(isEmailAddress('alerts@acme.com')).toBe(true)
    expect(isEmailAddress('not-an-email')).toBe(false)
    expect(isEmailAddress('https://hooks.slack.com/x')).toBe(false)
    expect(isEmailAddress('')).toBe(false)
  })
})

describe('parseSmtpConfig', () => {
  it('returns null without a host or from address', () => {
    expect(parseSmtpConfig({})).toBeNull()
    expect(parseSmtpConfig({ FLAKEMETRY_SMTP_HOST: 'smtp.test' })).toBeNull()
  })

  it('parses config and infers TLS on port 465', () => {
    const config = parseSmtpConfig({
      FLAKEMETRY_SMTP_HOST: 'smtp.test',
      FLAKEMETRY_SMTP_FROM: 'bot@acme.com',
      FLAKEMETRY_SMTP_PORT: '465',
      FLAKEMETRY_SMTP_USER: 'u',
      FLAKEMETRY_SMTP_PASS: 'p',
    })
    expect(config).toEqual({
      host: 'smtp.test',
      port: 465,
      secure: true,
      user: 'u',
      pass: 'p',
      from: 'bot@acme.com',
    })
  })

  it('defaults to port 587 without TLS', () => {
    const config = parseSmtpConfig({
      FLAKEMETRY_SMTP_HOST: 'smtp.test',
      FLAKEMETRY_SMTP_FROM: 'bot@acme.com',
    })
    expect(config?.port).toBe(587)
    expect(config?.secure).toBe(false)
  })
})
