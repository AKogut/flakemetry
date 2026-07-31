import { assertConformantBatch, TestRunRecorder } from '@flakemetry/sdk'
import { describe, expect, it } from 'vitest'

import { type JestAggregatedResult, mapJestResults } from '../mapping'

const ROOT = '/repo'
const START = new Date('2026-07-16T10:00:00Z')

const results: JestAggregatedResult = {
  startTime: START.getTime(),
  testResults: [
    {
      testFilePath: '/repo/src/login.test.ts',
      testResults: [
        { title: 'logs in', ancestorTitles: ['auth'], status: 'passed', duration: 12 },
        {
          title: 'rejects bad password',
          ancestorTitles: ['auth'],
          status: 'failed',
          duration: 30,
          failureMessages: ['AssertionError: expected 200\n    at login:5'],
        },
        {
          title: 'flakes on retry',
          ancestorTitles: ['auth', 'edge'],
          status: 'passed',
          duration: 40,
          retryReasons: ['flaked once'],
        },
        { title: 'is skipped', ancestorTitles: [], status: 'skipped' },
      ],
    },
  ],
}

const batchFrom = (input: JestAggregatedResult) => {
  const recorder = new TestRunRecorder({
    project: 'acme/web',
    commitSha: 'abc1234',
    branch: 'main',
    ciProvider: 'local',
    trigger: 'manual',
  })
  recorder.startRun(START)
  for (const test of mapJestResults(input, ROOT, START)) recorder.record(test)
  recorder.finishRun('failed', START)
  return recorder.toIngestBatch('jest-run-1')
}

describe('mapJestResults', () => {
  it('produces a conformant batch with relative paths and ancestor suites', () => {
    const batch = batchFrom(results)
    assertConformantBatch(batch)

    expect(batch.executions).toHaveLength(4)
    const byTitle = new Map(batch.executions.map((execution) => [execution.title, execution]))
    expect(byTitle.get('logs in')?.filePath).toBe('src/login.test.ts')
    expect(byTitle.get('logs in')?.suite).toBe('auth')
    expect(byTitle.get('flakes on retry')?.suite).toBe('auth > edge')
    expect(byTitle.get('is skipped')?.suite).toBe('')
  })

  it('maps statuses, treats a retried pass as flaky, and captures the first failure line', () => {
    const byTitle = new Map(
      batchFrom(results).executions.map((execution) => [execution.title, execution]),
    )
    expect(byTitle.get('logs in')?.status).toBe('pass')
    expect(byTitle.get('is skipped')?.status).toBe('skip')
    expect(byTitle.get('flakes on retry')?.status).toBe('flaky')
    const failed = byTitle.get('rejects bad password')
    expect(failed?.status).toBe('fail')
    expect(failed?.error?.message).toBe('AssertionError: expected 200')
  })
})
