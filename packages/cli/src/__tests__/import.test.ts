import { describe, expect, it } from 'vitest'

import {
  type HistoricalFile,
  importIdempotencyKey,
  planHistoricalImport,
  syntheticCommitSha,
} from '../commands/import'

const report = (cases: string, timestamp?: string): string =>
  `<testsuite name="suite" ${timestamp ? `timestamp="${timestamp}"` : ''}>${cases}</testsuite>`

const passing = '<testcase classname="checkout" name="pays" time="1.5"/>'
const failing =
  '<testcase classname="checkout" name="pays" time="1.5"><failure message="boom">stack</failure></testcase>'

const file = (
  path: string,
  content: string,
  modifiedAt = new Date('2026-01-01'),
): HistoricalFile => ({
  path,
  content,
  modifiedAt,
})

describe('planHistoricalImport', () => {
  it('orders runs oldest first', () => {
    const plan = planHistoricalImport([
      file('c.xml', report(passing, '2026-03-01T00:00:00Z')),
      file('a.xml', report(passing, '2026-01-01T00:00:00Z')),
      file('b.xml', report(failing, '2026-02-01T00:00:00Z')),
    ])

    // Scoring is incremental and stamps first-seen as it goes, so a newest-first import
    // would date every identity to the end of its own history.
    expect(plan.runs.map((run) => run.path)).toEqual(['a.xml', 'b.xml', 'c.xml'])
  })

  it('gives each report a distinct commit so history is not read as one commit flaking', () => {
    const plan = planHistoricalImport([
      file('a.xml', report(passing, '2026-01-01T00:00:00Z')),
      file('b.xml', report(failing, '2026-01-02T00:00:00Z')),
    ])

    const shas = plan.runs.map((run) => run.commitSha)
    expect(new Set(shas).size).toBe(2)
    // "same commit, different result" is a flakiness signal. One shared sha across months
    // of history would manufacture it for every test in the archive.
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('gives each report a distinct idempotency key, stable across re-runs', () => {
    const files = [
      file('a.xml', report(passing, '2026-01-01T00:00:00Z')),
      file('b.xml', report(passing, '2026-01-02T00:00:00Z')),
    ]

    const first = planHistoricalImport(files)
    const second = planHistoricalImport(files)

    // Identical keys would make the server deduplicate every report after the first,
    // importing one run out of an entire archive without saying so.
    expect(first.runs[0]?.idempotencyKey).not.toBe(first.runs[1]?.idempotencyKey)
    expect(first.runs.map((run) => run.idempotencyKey)).toEqual(
      second.runs.map((run) => run.idempotencyKey),
    )
    for (const run of first.runs) expect(run.idempotencyKey.length).toBeGreaterThanOrEqual(8)
  })

  it('takes the timestamp from the report, then the manifest, then the file', () => {
    const fromReport = planHistoricalImport([
      file('a.xml', report(passing, '2026-05-05T10:00:00Z'), new Date('2026-09-09')),
    ])
    expect(fromReport.runs[0]?.startedAt.toISOString()).toBe('2026-05-05T10:00:00.000Z')

    const fromManifest = planHistoricalImport(
      [file('a.xml', report(passing, '2026-05-05T10:00:00Z'))],
      { 'a.xml': { startedAt: '2025-12-25T08:00:00Z' } },
    )
    expect(fromManifest.runs[0]?.startedAt.toISOString()).toBe('2025-12-25T08:00:00.000Z')

    const fromFile = planHistoricalImport([
      file('a.xml', report(passing), new Date('2026-04-04T00:00:00Z')),
    ])
    expect(fromFile.runs[0]?.startedAt.toISOString()).toBe('2026-04-04T00:00:00.000Z')
  })

  it('honours real commit and branch when a manifest supplies them', () => {
    const plan = planHistoricalImport([file('a.xml', report(passing))], {
      'a.xml': { commitSha: 'abc1234def5678', branch: 'release/2026-01' },
    })

    expect(plan.runs[0]?.commitSha).toBe('abc1234def5678')
    expect(plan.runs[0]?.branch).toBe('release/2026-01')
  })

  it('reports what it skipped instead of dropping it silently', () => {
    const plan = planHistoricalImport([
      file('empty.xml', '<testsuite name="suite"></testsuite>'),
      file('broken.xml', 'not xml at all <<<'),
      file('good.xml', report(passing)),
    ])

    expect(plan.runs.map((run) => run.path)).toEqual(['good.xml'])
    expect(plan.skipped.map((skip) => skip.path).sort()).toEqual(['broken.xml', 'empty.xml'])
    expect(plan.skipped.find((skip) => skip.path === 'empty.xml')?.reason).toContain(
      'no test cases',
    )
  })
})

describe('derived identifiers', () => {
  it('derives the same commit for identical content and a different one otherwise', () => {
    expect(syntheticCommitSha('a')).toBe(syntheticCommitSha('a'))
    expect(syntheticCommitSha('a')).not.toBe(syntheticCommitSha('b'))
  })

  it('separates identical reports living at different paths', () => {
    // A CI archive commonly holds byte-identical reports per shard or per re-run.
    expect(importIdempotencyKey('shard-1/junit.xml', '<x/>')).not.toBe(
      importIdempotencyKey('shard-2/junit.xml', '<x/>'),
    )
  })
})
