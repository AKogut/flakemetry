import { assertConformantBatch, TestRunRecorder } from '@flakemetry/sdk'
import { describe, expect, it } from 'vitest'

import { mapVitestFiles, type VitestFile } from '../mapping'

const ROOT = '/repo'
const START = new Date('2026-07-16T10:00:00Z')

const files: VitestFile[] = [
  {
    type: 'suite',
    name: 'login.test.ts',
    filepath: '/repo/src/login.test.ts',
    tasks: [
      {
        type: 'suite',
        name: 'auth',
        tasks: [
          { type: 'test', name: 'logs in', result: { state: 'pass', duration: 12 } },
          {
            type: 'test',
            name: 'rejects bad password',
            result: {
              state: 'fail',
              duration: 30,
              errors: [{ name: 'AssertionError', message: 'expected 200', stack: 'at login:5' }],
            },
          },
          {
            type: 'test',
            name: 'flakes on retry',
            result: { state: 'pass', duration: 40, retryCount: 2 },
          },
        ],
      },
      { type: 'test', name: 'is skipped', result: { state: 'skip' } },
    ],
  },
]

const batchFrom = (input: VitestFile[]) => {
  const recorder = new TestRunRecorder(resolveContext())
  recorder.startRun(START)
  for (const test of mapVitestFiles(input, ROOT, START)) recorder.record(test)
  recorder.finishRun('failed', START)
  return recorder.toIngestBatch('vitest-1')
}

const resolveContext = () => ({
  project: 'acme/web',
  commitSha: 'abc1234',
  branch: 'main',
  ciProvider: 'local' as const,
  trigger: 'manual' as const,
})

describe('mapVitestFiles', () => {
  it('produces a conformant batch with workspace-relative paths and suite chains', () => {
    const batch = batchFrom(files)
    assertConformantBatch(batch)

    expect(batch.executions).toHaveLength(4)
    const byTitle = new Map(batch.executions.map((execution) => [execution.title, execution]))
    expect(byTitle.get('logs in')?.filePath).toBe('src/login.test.ts')
    expect(byTitle.get('logs in')?.suite).toBe('auth')
    expect(byTitle.get('is skipped')?.suite).toBe('')
  })

  it('maps states and marks a retried pass as flaky with the failure captured', () => {
    const batch = batchFrom(files)
    const byTitle = new Map(batch.executions.map((execution) => [execution.title, execution]))

    expect(byTitle.get('logs in')?.status).toBe('pass')
    expect(byTitle.get('is skipped')?.status).toBe('skip')
    expect(byTitle.get('flakes on retry')?.status).toBe('flaky')
    const failed = byTitle.get('rejects bad password')
    expect(failed?.status).toBe('fail')
    expect(failed?.error?.message).toBe('expected 200')
  })

  it('gives distinct fingerprints to tests that differ only by title', () => {
    const batch = batchFrom(files)
    const fingerprints = new Set(mapVitestFiles(files, ROOT, START).map((test) => test.title))
    expect(fingerprints.size).toBe(4)
    expect(batch.executions.every((execution) => execution.title.length > 0)).toBe(true)
  })
})
