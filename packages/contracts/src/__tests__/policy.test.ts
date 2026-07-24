import { describe, expect, it } from 'vitest'

import {
  normalizePolicyOverrides,
  POLICY_DEFAULTS,
  projectPolicyEnvOverrides,
  projectPolicyInputSchema,
  resolveProjectPolicy,
} from '../policy'

describe('resolveProjectPolicy precedence', () => {
  it('falls back to defaults when no layers are set', () => {
    const policy = resolveProjectPolicy({})
    expect(policy.flakyThreshold).toEqual({
      value: POLICY_DEFAULTS.flakyThreshold,
      source: 'default',
    })
    expect(policy.minSamples).toEqual({ value: POLICY_DEFAULTS.minSamples, source: 'default' })
    expect(policy.aiRcaEnabled).toEqual({ value: POLICY_DEFAULTS.aiRcaEnabled, source: 'default' })
  })

  it('lets a UI value override the default', () => {
    const policy = resolveProjectPolicy({ ui: { flakyThreshold: 0.7 } })
    expect(policy.flakyThreshold).toEqual({ value: 0.7, source: 'ui' })
    expect(policy.minSamples.source).toBe('default')
  })

  it('lets env override both UI and default', () => {
    const policy = resolveProjectPolicy({
      ui: { flakyThreshold: 0.7, minSamples: 3 },
      env: { flakyThreshold: 0.95 },
    })
    expect(policy.flakyThreshold).toEqual({ value: 0.95, source: 'env' })
    expect(policy.minSamples).toEqual({ value: 3, source: 'ui' })
  })

  it('treats a null UI field as inherit, not as a value', () => {
    const policy = resolveProjectPolicy({ ui: { flakyThreshold: null } })
    expect(policy.flakyThreshold).toEqual({
      value: POLICY_DEFAULTS.flakyThreshold,
      source: 'default',
    })
  })

  it('honours a false boolean as a real override, not a fallback', () => {
    const policy = resolveProjectPolicy({ ui: { aiRcaEnabled: false } })
    expect(policy.aiRcaEnabled).toEqual({ value: false, source: 'ui' })
  })
})

describe('normalizePolicyOverrides', () => {
  it('drops null and undefined fields and keeps concrete values', () => {
    const overrides = normalizePolicyOverrides({
      flakyThreshold: 0.6,
      minSamples: null,
      quarantineEnabled: false,
      aiRcaEnabled: undefined,
    })
    expect(overrides).toEqual({ flakyThreshold: 0.6, quarantineEnabled: false })
  })

  it('returns an empty object for a null row', () => {
    expect(normalizePolicyOverrides(null)).toEqual({})
  })
})

describe('projectPolicyEnvOverrides', () => {
  it('maps FLAKEMETRY_* variables into policy fields', () => {
    const overrides = projectPolicyEnvOverrides({
      FLAKEMETRY_FLAKY_THRESHOLD: '0.9',
      FLAKEMETRY_FLAKY_MIN_SAMPLES: '8',
      FLAKEMETRY_QUARANTINE_ENABLED: 'true',
      FLAKEMETRY_AI_RCA: '0',
    })
    expect(overrides).toEqual({
      flakyThreshold: 0.9,
      minSamples: 8,
      quarantineEnabled: true,
      aiRcaEnabled: false,
    })
  })

  it('ignores empty and absent variables', () => {
    expect(projectPolicyEnvOverrides({ FLAKEMETRY_FLAKY_THRESHOLD: '' })).toEqual({})
  })
})

describe('projectPolicyInputSchema', () => {
  it('accepts partial input with nullable fields', () => {
    const parsed = projectPolicyInputSchema.parse({ flakyThreshold: 0.5, aiRcaEnabled: null })
    expect(parsed).toEqual({ flakyThreshold: 0.5, aiRcaEnabled: null })
  })

  it('rejects an out-of-range threshold', () => {
    expect(() => projectPolicyInputSchema.parse({ flakyThreshold: 1.5 })).toThrow()
  })

  it('rejects a non-integer minSamples', () => {
    expect(() => projectPolicyInputSchema.parse({ minSamples: 2.5 })).toThrow()
  })
})
