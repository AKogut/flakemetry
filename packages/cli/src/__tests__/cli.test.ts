import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findConfigFile, redactToken, resolveConfig, resolveToken } from '../config-loader'
import { CommandRegistry } from '../registry'

const makeProject = (yaml?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'flakemetry-cli-'))
  if (yaml !== undefined) writeFileSync(join(dir, 'flakemetry.yml'), yaml)
  return dir
}

describe('config loader', () => {
  it('finds the config file walking up from a nested directory', () => {
    const dir = makeProject('flaky:\n  threshold: 0.7\n')
    expect(findConfigFile(dir)).toBe(join(dir, 'flakemetry.yml'))
  })

  it('resolves file config with env override winning', () => {
    const dir = makeProject('flaky:\n  threshold: 0.7\n  minSamples: 12\n')
    const { config, configPath } = resolveConfig(dir, { FLAKEMETRY_FLAKY_THRESHOLD: '0.95' })
    expect(configPath).not.toBeNull()
    expect(config.flaky.threshold).toBe(0.95)
    expect(config.flaky.minSamples).toBe(12)
  })

  it('falls back to defaults without a file', () => {
    const dir = makeProject()
    const { config, configPath } = resolveConfig(join(dir), {})
    expect(configPath).toBeNull()
    expect(config.flaky.threshold).toBe(0.8)
  })
})

describe('token handling', () => {
  it('resolves the token from env and redacts it for display', () => {
    expect(resolveToken({ FLAKEMETRY_TOKEN: 'fmk_1234567890abcdef' })).toBe('fmk_1234567890abcdef')
    expect(resolveToken({})).toBeNull()
    expect(redactToken('fmk_1234567890abcdef')).toBe('fmk_…cdef')
  })
})

describe('command registry', () => {
  it('rejects duplicate command names', () => {
    const registry = new CommandRegistry()
    const module = { name: 'x', description: 'x', register: () => undefined }
    registry.add(module)
    expect(() => registry.add(module)).toThrow('already registered')
  })
})
