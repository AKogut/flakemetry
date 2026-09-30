import { describe, expect, it } from 'vitest'

import { definePlugin, PLUGIN_API_VERSION, pluginSignalsSchema, validatePlugin } from '../plugin'

const analyzer = definePlugin({
  name: 'slow-outlier',
  apiVersion: PLUGIN_API_VERSION,
  analyze: () => [],
})

describe('validatePlugin', () => {
  it('accepts a plugin with an analyzer, a parser or both', () => {
    expect(validatePlugin(analyzer, 'a.mjs')).toBe(analyzer)
    expect(() =>
      validatePlugin(
        { name: 'tap', apiVersion: 1, parse: () => ({ startedAt: null, executions: [] }) },
        'b.mjs',
      ),
    ).not.toThrow()
  })

  it('names the source when the export is not a plugin at all', () => {
    expect(() => validatePlugin({ hello: 'world' }, './plugins/x.mjs')).toThrow(
      /\.\/plugins\/x\.mjs/,
    )
  })

  it('refuses a plugin built for another API version, saying which', () => {
    expect(() => validatePlugin({ ...analyzer, apiVersion: 2 }, 'a.mjs')).toThrow(
      /targets plugin API 2; this server supports 1/,
    )
  })

  it('refuses a plugin that does nothing', () => {
    expect(() => validatePlugin({ name: 'empty', apiVersion: 1 }, 'a.mjs')).toThrow(/neither/)
  })

  it('refuses hooks that are not functions', () => {
    expect(() => validatePlugin({ ...analyzer, analyze: 'yes' }, 'a.mjs')).toThrow(/analyze/)
  })

  it('refuses a name that could not be a route segment', () => {
    expect(() => validatePlugin({ ...analyzer, name: 'Slow Outlier' }, 'a.mjs')).toThrow(/name/)
  })
})

describe('pluginSignalsSchema', () => {
  const signal = {
    testIdentityId: '6f1c6d4e-2b1a-4c1e-9a55-3f1b2c3d4e5f',
    code: 'SLOW_OUTLIER',
    severity: 'warning' as const,
    message: 'took 3.1× its median',
  }

  it('accepts a well-formed signal', () => {
    expect(pluginSignalsSchema.parse([signal])).toHaveLength(1)
  })

  it('rejects a code that is not upper snake case', () => {
    expect(pluginSignalsSchema.safeParse([{ ...signal, code: 'slow' }]).success).toBe(false)
  })

  it('caps how many signals one analyzer may return', () => {
    expect(pluginSignalsSchema.safeParse(Array.from({ length: 1001 }, () => signal)).success).toBe(
      false,
    )
  })
})
