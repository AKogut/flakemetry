import { describe, expect, it } from 'vitest'

import {
  noTestsBatch,
  ownTestsBatch,
  restfulReporterBatch,
  withJobConclusion,
  withoutTargetIndependentTests,
} from '../lib/batches.mjs'

const meta = {
  slug: 'restful-booker',
  runId: 1,
  sha: 'abc1234',
  branch: 'main',
  event: 'schedule',
  startedAt: '2026-11-04T03:00:00Z',
}

const execution = (overrides) => ({
  filePath: 'tests/smoke/rooms.test.ts',
  suite: 'room service @smoke',
  title: 'returns a created room by id',
  status: 'flaky',
  attempt: 1,
  ...overrides,
})

describe('restfulReporterBatch', () => {
  it('names a test the way its JUnit history does, so the history stays attached', () => {
    const batch = restfulReporterBatch(
      { resource: {}, executions: [execution()] },
      meta,
      'live',
      'r1-live',
    )

    expect(batch.executions[0]).toMatchObject({
      filePath: 'tests/smoke/rooms.test.ts',
      suite: 'tests/smoke/rooms.test.ts',
      title: 'room service @smoke > returns a created room by id',
      status: 'flaky',
      params: { variant: 'live' },
    })
    expect(batch.resource.variant).toBe('live')
  })

  it('leaves out unit and contract tests, because they say nothing about a target', () => {
    const batch = restfulReporterBatch(
      {
        resource: {},
        executions: [
          execution(),
          execution({ filePath: 'tests/unit/a.test.ts' }),
          execution({ filePath: 'tests/pact/b.test.ts' }),
        ],
      },
      meta,
      'live',
      'r1-live',
    )
    expect(batch.executions).toHaveLength(1)
  })
})

describe('withJobConclusion', () => {
  const passed = { contractVersion: '0.1.0', run: { status: 'passed', startedAt: 'x' } }

  it('turns a green run with a failed job red', () => {
    expect(withJobConclusion(passed, 'failure').run.status).toBe('failed')
  })

  it('turns a red run with a successful job green', () => {
    const failed = { ...passed, run: { ...passed.run, status: 'failed' } }
    expect(withJobConclusion(failed, 'success').run.status).toBe('passed')
  })

  it('records a cancelled job as cancelled, whatever its tests did', () => {
    expect(withJobConclusion(passed, 'cancelled').run.status).toBe('canceled')
    expect(withJobConclusion(noTestsBatch(meta, 'xcuitest', 'r1'), 'cancelled').run.status).toBe(
      'canceled',
    )
  })

  it('leaves the status alone when the job has no verdict', () => {
    expect(withJobConclusion(passed, null)).toBe(passed)
    expect(withJobConclusion(passed, undefined)).toBe(passed)
    expect(withJobConclusion(passed, 'skipped')).toBe(passed)
  })

  it('passes on an empty result', () => {
    expect(withJobConclusion(null, 'failure')).toBeNull()
  })

  it('keeps the bytes of a batch whose status is already right', () => {
    expect(JSON.stringify(withJobConclusion(passed, 'success'))).toBe(JSON.stringify(passed))
  })
})

describe('withoutTargetIndependentTests', () => {
  it('passes on an empty result', () => {
    expect(withoutTargetIndependentTests(null)).toBeNull()
  })
})

describe('ownTestsBatch', () => {
  const report = (classname, name) =>
    `<testsuites><testsuite name="s"><testcase classname="${classname}" name="${name}" time="1"/></testsuite></testsuites>`

  it('merges the report of every package, with paths that cannot collide', () => {
    const batch = ownTestsBatch(
      [
        { directory: 'packages/core', xml: report('src/__tests__/a.test.ts', 'one') },
        { directory: 'apps/api', xml: report('src/__tests__/a.test.ts', 'one') },
      ],
      { ...meta, slug: 'flakemetry' },
      'r1',
    )

    expect(batch.executions.map((execution) => execution.filePath)).toEqual([
      'packages/core/src/__tests__/a.test.ts',
      'apps/api/src/__tests__/a.test.ts',
    ])
    expect(batch.executions[0].params).toBeUndefined()
  })

  it('returns nothing when there are no results', () => {
    expect(ownTestsBatch([], meta, 'r1')).toBeNull()
  })
})
