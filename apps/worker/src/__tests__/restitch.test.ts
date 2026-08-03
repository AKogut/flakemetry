import { describe, expect, it } from 'vitest'

import { parseRestitchArgs } from '../restitch'

const parse = (...argv: string[]) => parseRestitchArgs(argv)

describe('parseRestitchArgs', () => {
  it('reads a project and defaults to a dry run', () => {
    const parsed = parse('--project', 'p-1')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // Nothing is written unless --apply is passed explicitly.
    expect(parsed.args).toEqual({
      projectId: 'p-1',
      apply: false,
      minConfidence: undefined,
      limit: undefined,
    })
  })

  it('reads the optional bounds', () => {
    const parsed = parse('--project', 'p-1', '--apply', '--min-confidence', '0.8', '--limit', '5')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args).toEqual({
      projectId: 'p-1',
      apply: true,
      minConfidence: 0.8,
      limit: 5,
    })
  })

  it('requires a project', () => {
    expect(parse().ok).toBe(false)
    expect(parse('--apply')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('project'),
    })
  })

  it('refuses a flag whose value was left off rather than eating the next flag', () => {
    // Without this, --project would swallow "--apply" and run against a project
    // named "--apply" — while apply itself stayed on.
    expect(parse('--project', '--apply')).toMatchObject({ ok: false })
  })

  it('rejects bounds that are not numbers instead of silently matching nothing', () => {
    // Number("abc") is NaN, and every comparison against NaN is false, so a typo
    // used to report "0 candidates" — indistinguishable from having nothing to do.
    expect(parse('--project', 'p-1', '--min-confidence', 'abc')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('min-confidence'),
    })
    expect(parse('--project', 'p-1', '--limit', 'abc')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('limit'),
    })
  })

  it('rejects bounds that are out of range', () => {
    expect(parse('--project', 'p-1', '--min-confidence', '0')).toMatchObject({ ok: false })
    expect(parse('--project', 'p-1', '--min-confidence', '1.5')).toMatchObject({ ok: false })
    expect(parse('--project', 'p-1', '--limit', '0')).toMatchObject({ ok: false })
    expect(parse('--project', 'p-1', '--limit', '2.5')).toMatchObject({ ok: false })
  })

  it('accepts the boundary values', () => {
    expect(parse('--project', 'p-1', '--min-confidence', '1', '--limit', '1')).toMatchObject({
      ok: true,
    })
  })
})
