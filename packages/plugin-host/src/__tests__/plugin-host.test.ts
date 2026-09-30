import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  loadPlugins,
  parsePluginSpecifiers,
  PluginTimeoutError,
  resolvePluginTimeout,
  withDeadline,
} from '../index'

const examples = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../examples/plugins',
)

const writeModule = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'flakemetry-plugin-'))
  const file = join(dir, 'plugin.mjs')
  writeFileSync(file, source)
  return file
}

describe('parsePluginSpecifiers', () => {
  it('splits on commas and drops blanks', () => {
    expect(parsePluginSpecifiers(' ./a.mjs, ,@acme/plugin ')).toEqual(['./a.mjs', '@acme/plugin'])
    expect(parsePluginSpecifiers(undefined)).toEqual([])
  })
})

describe('resolvePluginTimeout', () => {
  it('uses a positive integer and falls back otherwise', () => {
    expect(resolvePluginTimeout({ FLAKEMETRY_PLUGIN_TIMEOUT_MS: '250' })).toBe(250)
    expect(resolvePluginTimeout({ FLAKEMETRY_PLUGIN_TIMEOUT_MS: 'soon' })).toBe(5000)
  })
})

describe('loadPlugins', () => {
  it('loads the reference plugins by relative path', async () => {
    const plugins = await loadPlugins(['./slow-outlier.mjs', './tap.mjs'], examples)
    expect(plugins.map((plugin) => plugin.name)).toEqual(['slow-outlier', 'tap'])
    expect(typeof plugins[0]?.analyze).toBe('function')
    expect(typeof plugins[1]?.parse).toBe('function')
  })

  it('says which module could not be found', async () => {
    await expect(loadPlugins(['./missing.mjs'], examples)).rejects.toThrow(
      /plugin \.\/missing\.mjs could not be loaded/,
    )
  })

  it('refuses a module that is not a plugin, naming it', async () => {
    const file = writeModule('export default { hello: "world" }\n')
    await expect(loadPlugins([file])).rejects.toThrow(/is not a Flakemetry plugin/)
  })

  it('refuses two plugins with the same name', async () => {
    const file = writeModule('export default { name: "twin", apiVersion: 1, analyze: () => [] }\n')
    const copy = writeModule('export default { name: "twin", apiVersion: 1, analyze: () => [] }\n')
    await expect(loadPlugins([file, copy])).rejects.toThrow(/two plugins are named twin/)
  })
})

describe('withDeadline', () => {
  it('returns what the work returns', async () => {
    await expect(withDeadline(() => 42, 100, 'fast')).resolves.toBe(42)
  })

  it('gives up on work that runs past the deadline', async () => {
    const never = () => new Promise<never>(() => undefined)
    await expect(withDeadline(never, 20, 'plugin slow')).rejects.toBeInstanceOf(PluginTimeoutError)
  })

  it('passes a thrown error through', async () => {
    await expect(
      withDeadline(
        () => {
          throw new Error('boom')
        },
        100,
        'plugin broken',
      ),
    ).rejects.toThrow('boom')
  })
})

describe('the TAP reference plugin', () => {
  const sample = `TAP version 13
# Subtest: math
    # Subtest: adds
    ok 1 - adds
      ---
      duration_ms: 3.4
      type: 'test'
      ...
    # Subtest: fails with a sentinel
    not ok 2 - fails with a sentinel
      ---
      duration_ms: 1.2
      type: 'test'
      error: "'sentinel-tap-failure' == 'other'"
      name: 'AssertionError'
      stack: |-
        TestContext.<anonymous> (file:///repo/tests/math.test.mjs:5:44)
        Test.run (node:internal/test_runner/test:1047:25)
      ...
    # Subtest: is skipped
    ok 3 - is skipped # SKIP
      ---
      duration_ms: 0.1
      type: 'test'
      ...
    1..3
not ok 1 - math
  ---
  duration_ms: 5.0
  type: 'suite'
  ...
# Subtest: top level
ok 2 - top level
  ---
  duration_ms: 0.4
  type: 'test'
  ...
1..2
`

  it('parses node --test TAP output into leaf tests with their suites', async () => {
    const [tap] = await loadPlugins(['./tap.mjs'], examples)
    const report = await tap?.parse?.(sample)

    expect(
      report?.executions.map(({ suite, title, status }) => ({ suite, title, status })),
    ).toEqual([
      { suite: 'math', title: 'adds', status: 'pass' },
      { suite: 'math', title: 'fails with a sentinel', status: 'fail' },
      { suite: 'math', title: 'is skipped', status: 'skip' },
      { suite: '', title: 'top level', status: 'pass' },
    ])
    const failure = report?.executions[1]?.error
    expect(failure?.message).toBe("'sentinel-tap-failure' == 'other'")
    expect(failure?.stack).toContain('math.test.mjs:5:44')
    expect(report?.executions[0]?.durationMs).toBe(3)
  })
})
