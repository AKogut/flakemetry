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
): TestResult =>
  ({
    status,
    retry,
    duration: 1500,
    startTime: new Date('2026-07-16T10:00:00Z'),
    error,
  }) as unknown as TestResult

const drive = async (outputFile: string) => {
  const reporter = new FlakemetryReporter({ outputFile })
  reporter.onBegin({ rootDir } as FullConfig, {} as Suite)

  const pass = makeTest('t1', 'logs in', 'auth')
  reporter.onTestEnd(pass, makeResult('passed', 0))

  const fail = makeTest('t2', 'rejects invalid', 'auth')
  reporter.onTestEnd(
    fail,
    makeResult('failed', 0, {
      message: 'expected true',
      stack: 'at login:5',
    } as TestResult['error']),
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
    vi.stubEnv('GITHUB_ACTIONS', '')
    vi.stubEnv('FLAKEMETRY_PROJECT', 'acme/web')
    vi.stubEnv('FLAKEMETRY_COMMIT_SHA', 'deadbeef')
    vi.stubEnv('FLAKEMETRY_ENDPOINT', '')
    vi.stubEnv('FLAKEMETRY_TOKEN', '')
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
})
