import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import FlakemetryJestReporter from '../index'
import type { JestAggregatedResult } from '../mapping'

const results: JestAggregatedResult = {
  startTime: Date.parse('2026-09-30T10:00:00Z'),
  testResults: [
    {
      testFilePath: '/repo/src/login.test.ts',
      testResults: [{ title: 'logs in', ancestorTitles: ['auth'], status: 'passed', duration: 5 }],
    },
  ],
}

const keyForShard = async (shardIndex: number): Promise<string> => {
  const outputFile = join(tmpdir(), `flakemetry-${randomUUID()}.json`)
  const reporter = new FlakemetryJestReporter(
    { rootDir: '/repo', shard: { shardIndex, shardCount: 2 } },
    { outputFile },
  )
  Object.assign(reporter as unknown as Record<string, unknown>, {
    env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '9000001', GITHUB_RUN_ATTEMPT: '1' },
  })
  await reporter.onRunComplete(undefined, results)
  return (JSON.parse(readFileSync(outputFile, 'utf8')) as { idempotencyKey: string }).idempotencyKey
}

describe('a sharded Jest run', () => {
  it('gives each shard its own idempotency key, so the second is not dropped as a re-delivery', async () => {
    const first = await keyForShard(1)
    const second = await keyForShard(2)

    expect(first).toBe('github_actions-9000001-1-shard1')
    expect(second).toBe('github_actions-9000001-1-shard2')
  })
})

describe('a Jest config with several projects', () => {
  const executionsWith = async (contexts: { size: number }) => {
    const outputFile = join(tmpdir(), `flakemetry-${randomUUID()}.json`)
    const reporter = new FlakemetryJestReporter({ rootDir: '/repo' } as never, { outputFile })
    await reporter.onRunComplete(contexts, {
      startTime: 1,
      testResults: [
        {
          testFilePath: '/repo/a.test.js',
          displayName: { name: 'jsdom' },
          testResults: [{ title: 't', status: 'passed' }],
        },
      ],
    })
    return (
      JSON.parse(readFileSync(outputFile, 'utf8')) as {
        executions: { params?: Record<string, string> }[]
      }
    ).executions
  }

  it('records the project as the variant', async () => {
    expect((await executionsWith({ size: 2 }))[0]?.params).toEqual({ variant: 'jsdom' })
  })

  it('leaves a single project on its existing identity', async () => {
    expect((await executionsWith({ size: 1 }))[0]?.params).toBeUndefined()
  })
})
