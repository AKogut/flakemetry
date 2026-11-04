import { describe, expect, it } from 'vitest'

import { restfulReporterBatch, withoutTargetIndependentTests } from '../lib/batches.mjs'

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

describe('withoutTargetIndependentTests', () => {
  it('passes on an empty result', () => {
    expect(withoutTargetIndependentTests(null)).toBeNull()
  })
})
