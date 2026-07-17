import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestRunBatchSchema } from '@flakemetry/contracts'
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FlakemetryReporter from '../reporter'

const rootDir = '/repo'

const makeSuiteChain = (describeTitle: string): Suite => {
  const root = { type: 'root', title: '', parent: undefined } as unknown as Suite
  const file = { type: 'file', title: 'login.spec.ts', parent: root } as unknown as Suite
  return { type: 'describe', title: describeTitle, parent: file } as unknown as Suite
}

const makeTest = (id: string, title: string, describeTitle: string): TestCase =>
  ({
    id,
    title,
    location: { file: `${rootDir}/e2e/login.spec.ts`, line: 1, column: 1 },
    parent: makeSuiteChain(describeTitle),
  }) as unknown as TestCase

const makeResult = (
  status: TestResult['status'],
  retry: number,
  error?: TestResult['error'],
  attachments: TestResult['attachments'] = [],
): TestResult =>
  ({
    status,
    retry,
    duration: 1500,
    startTime: new Date('2026-07-16T10:00:00Z'),
    error,
    attachments,
  }) as unknown as TestResult

const drive = async (outputFile: string) => {
  const reporter = new FlakemetryReporter({ outputFile })
  reporter.onBegin({ rootDir } as FullConfig, {} as Suite)

  const pass = makeTest('t1', 'logs in', 'auth')
  reporter.onTestEnd(pass, makeResult('passed', 0))

  const fail = makeTest('t2', 'rejects invalid', 'auth')
  reporter.onTestEnd(
    fail,
    makeResult(
      'failed',
      0,
      {
        message: 'expected true',
        stack: 'at login:5',
      } as TestResult['error'],
      [
        { name: 'screenshot', contentType: 'image/png', path: `${rootDir}/test-results/shot.png` },
        { name: 'stdout', contentType: 'text/plain', body: Buffer.from('x') },
      ] as unknown as TestResult['attachments'],
    ),
  )

  const flaky = makeTest('t3', 'completes payment', 'checkout')
  reporter.onTestEnd(
    flaky,
    makeResult('failed', 0, { message: 'race', stack: 'at pay:9' } as TestResult['error']),
  )
  reporter.onTestEnd(flaky, makeResult('passed', 1))

  await reporter.onEnd({ status: 'failed' } as FullResult)
}

describe('FlakemetryReporter lifecycle', () => {
  beforeEach(() => {
    for (const key of [
      'GITHUB_ACTIONS',
      'GITHUB_SHA',
      'GITHUB_REF',
      'GITHUB_REF_NAME',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_EVENT_NAME',
      'FLAKEMETRY_ENDPOINT',
      'FLAKEMETRY_TOKEN',
      'FLAKEMETRY_IDEMPOTENCY_KEY',
    ]) {
      vi.stubEnv(key, '')
    }
    vi.stubEnv('FLAKEMETRY_PROJECT', 'acme/web')
    vi.stubEnv('FLAKEMETRY_COMMIT_SHA', 'deadbeef')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('produces a contract-valid batch from a full run', async () => {
    const outputFile = join(tmpdir(), `flakemetry-reporter-${process.hrtime.bigint()}.json`)
    await drive(outputFile)

    const raw = JSON.parse(readFileSync(outputFile, 'utf8'))
    const batch = ingestRunBatchSchema.parse(raw)

    expect(batch.resource.commitSha).toBe('deadbeef')
    expect(batch.resource.ciProvider).toBe('local')
    expect(batch.run.status).toBe('failed')
    expect(batch.executions).toHaveLength(4)
  })

  it('maps statuses and links the flaky retry to its first attempt', async () => {
    const outputFile = join(tmpdir(), `flakemetry-reporter-${process.hrtime.bigint()}.json`)
    await drive(outputFile)

    const batch = ingestRunBatchSchema.parse(JSON.parse(readFileSync(outputFile, 'utf8')))
    const [pass, fail, flakyFirst, flakyRetry] = batch.executions

    expect(pass?.status).toBe('pass')
    expect(fail?.status).toBe('fail')
    expect(fail?.error?.message).toBe('expected true')
    expect(flakyFirst?.status).toBe('fail')
    expect(flakyFirst?.attempt).toBe(1)
    expect(flakyRetry?.status).toBe('flaky')
    expect(flakyRetry?.attempt).toBe(2)
    expect(flakyRetry?.retryOfIndex).toBe(2)
    expect(batch.executions[1]?.suite).toBe('auth')
    expect(flakyRetry?.suite).toBe('checkout')
  })

  it('captures path-backed attachments as workspace-relative artifact refs', async () => {
    const outputFile = join(tmpdir(), `flakemetry-reporter-${process.hrtime.bigint()}.json`)
    await drive(outputFile)

    const batch = ingestRunBatchSchema.parse(JSON.parse(readFileSync(outputFile, 'utf8')))
    const fail = batch.executions[1]

    expect(fail?.artifacts).toEqual([
      { name: 'screenshot', contentType: 'image/png', path: 'test-results/shot.png' },
    ])
    expect(batch.executions[0]?.artifacts ?? []).toHaveLength(0)
  })
})
