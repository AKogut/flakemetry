import { describe, expect, it } from 'vitest'

import {
  configFromEnv,
  ConfigValidationError,
  mergeConfigLayers,
  parseFlakemetryConfig,
} from '../config'

describe('flakemetry config schema', () => {
  it('applies defaults on an empty config', () => {
    const config = parseFlakemetryConfig({})
    expect(config.flaky.threshold).toBe(0.8)
    expect(config.flaky.minSamples).toBe(5)
    expect(config.quarantine.enabled).toBe(false)
    expect(config.ai.rca).toBe(true)
    expect(config.retention.rawDays).toBe(90)
  })

  it('points at the offending key on validation failure', () => {
    try {
      parseFlakemetryConfig({ flaky: { threshold: 1.5 } })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).issues[0]).toContain('flaky.threshold')
    }
  })

  it('rejects unknown keys to catch typos', () => {
    expect(() => parseFlakemetryConfig({ flakey: {} })).toThrow(ConfigValidationError)
  })
})

describe('config precedence', () => {
  it('merges file < settings < env with env winning', () => {
    const file = { flaky: { threshold: 0.7, minSamples: 10 }, ignore: ['**/*.setup.ts'] }
    const settings = { flaky: { threshold: 0.75 } }
    const env = configFromEnv({ FLAKEMETRY_FLAKY_THRESHOLD: '0.9' })
    const config = mergeConfigLayers(file, settings, env)
    expect(config.flaky.threshold).toBe(0.9)
    expect(config.flaky.minSamples).toBe(10)
    expect(config.ignore).toEqual(['**/*.setup.ts'])
  })

  it('maps env vars with type coercion', () => {
    const env = configFromEnv({
      FLAKEMETRY_ENDPOINT: 'https://ingest.flakemetry.dev',
      FLAKEMETRY_QUARANTINE_ENABLED: 'true',
      FLAKEMETRY_AI_DAILY_TOKEN_BUDGET: '50000',
    })
    const config = mergeConfigLayers(env)
    expect(config.endpoint).toBe('https://ingest.flakemetry.dev')
    expect(config.quarantine.enabled).toBe(true)
    expect(config.ai.dailyTokenBudget).toBe(50_000)
  })
})
