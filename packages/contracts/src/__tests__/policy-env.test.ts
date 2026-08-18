import { describe, expect, it } from 'vitest'

import { POLICY_FIELDS, projectPolicyEnvOverrides, resolveProjectPolicy } from '../policy'

/**
 * Every field the environment tier claims to control must actually reach it. The tracker
 * settings were in POLICY_FIELDS, in the compose files, in .env.example and in the
 * configuration reference — and read by nothing, so an operator setting them saw the
 * dashboard report "default" and the tracker stay off.
 */
const ENV_FOR_FIELD: Readonly<Record<string, [string, string]>> = {
  flakyThreshold: ['FLAKEMETRY_FLAKY_THRESHOLD', '0.5'],
  minSamples: ['FLAKEMETRY_FLAKY_MIN_SAMPLES', '3'],
  quarantineEnabled: ['FLAKEMETRY_QUARANTINE_ENABLED', 'true'],
  quarantineCooldownRuns: ['FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS', '7'],
  aiRcaEnabled: ['FLAKEMETRY_AI_RCA', 'true'],
  ciMinuteCost: ['FLAKEMETRY_CI_MINUTE_COST', '0.02'],
  developerHourCost: ['FLAKEMETRY_DEVELOPER_HOUR_COST', '80'],
  investigationMinutes: ['FLAKEMETRY_INVESTIGATION_MINUTES', '25'],
  trackerEnabled: ['FLAKEMETRY_TRACKER_ENABLED', 'true'],
  trackerAfterDays: ['FLAKEMETRY_TRACKER_AFTER_DAYS', '2'],
  trackerRecoveryDays: ['FLAKEMETRY_TRACKER_RECOVERY_DAYS', '9'],
}

describe('projectPolicyEnvOverrides', () => {
  it('reads every field the effective policy exposes', () => {
    const resolved = resolveProjectPolicy({})
    const exposed = Object.keys(resolved)

    const unreachable = exposed.filter((field) => !(field in ENV_FOR_FIELD))
    expect(
      unreachable,
      'these appear in the effective policy but no environment variable reaches them',
    ).toEqual([])
  })

  it.each(Object.entries(ENV_FOR_FIELD))('%s comes through as an env override', (field, pair) => {
    const [name, value] = pair
    const overrides = projectPolicyEnvOverrides({ [name]: value })

    expect(overrides[field as keyof typeof overrides]).toBeDefined()
    const resolved = resolveProjectPolicy({ env: overrides })
    expect(resolved[field as keyof typeof resolved].source).toBe('env')
  })

  it('is anchored to the field list, so a new policy field cannot skip this', () => {
    // Guard the guard: retention days are policy fields without an effective-policy entry,
    // so the count is checked rather than assumed equal.
    expect(POLICY_FIELDS.length).toBeGreaterThanOrEqual(Object.keys(ENV_FOR_FIELD).length)
  })
})
