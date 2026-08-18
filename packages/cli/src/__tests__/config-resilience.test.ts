import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveConfig, tryResolveConfig } from '../config-loader'

const withConfig = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-cfg-'))
  writeFileSync(join(dir, 'flakemetry.yml'), body)
  return dir
}

const BROKEN = `project: acme/web
flaky:
  threshold: 1.5
nonsense_key: true
`

describe('tryResolveConfig', () => {
  it('reports an invalid config instead of raising', () => {
    const attempt = tryResolveConfig(withConfig(BROKEN), {})

    expect(attempt.resolved).toBeNull()
    expect(attempt.error).toContain('flaky.threshold')
  })

  it('still resolves a good one', () => {
    const attempt = tryResolveConfig(withConfig('project: acme/web\n'), {})

    expect(attempt.error).toBeNull()
    expect(attempt.resolved?.config.project).toBe('acme/web')
  })

  it('leaves resolveConfig throwing for callers that need the config', () => {
    // `config` and `doctor` exist to tell you the configuration is wrong; they must not
    // shrug it off the way the wrapper does.
    expect(() => resolveConfig(withConfig(BROKEN), {})).toThrow(/flaky.threshold/)
  })
})
