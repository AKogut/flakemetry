import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ingestRunBatchSchema } from '@flakemetry/contracts'
import { describe, expect, it, vi } from 'vitest'

import { listAllureResultFiles, runAllureUpload } from '../commands/allure'
import { runXcresultUpload } from '../commands/xcresult'

const captureFetch = () => {
  const bodies: unknown[] = []
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    return {
      ok: true,
      status: 202,
      json: async () => ({ receiptId: 'receipt-1', acceptedExecutions: 2 }),
    }
  }) as unknown as typeof fetch
  return { bodies, fetchImpl }
}

const attempt = (status: string, start: number) => ({
  name: 'TC-1',
  fullName: 'a.spec.ts#suite.TC-1',
  historyId: 'one',
  status,
  start,
  stop: start + 10,
  labels: [{ name: 'parentSuite', value: 'suite' }],
})

const allureDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'flakemetry-allure-'))
  const nested = join(directory, 'ios')
  mkdirSync(nested)
  writeFileSync(join(nested, 'a-result.json'), JSON.stringify(attempt('failed', 1000)))
  writeFileSync(join(nested, 'b-result.json'), JSON.stringify(attempt('passed', 2000)))
  writeFileSync(join(nested, 'c-container.json'), JSON.stringify({ name: 'not a result' }))
  writeFileSync(join(directory, 'environment.properties'), 'platform=ios')
  return directory
}

describe('flakemetry allure', () => {
  it('finds results in nested directories and ignores everything else', () => {
    const files = listAllureResultFiles(allureDirectory())
    expect(files.map((file) => file.split('/').pop())).toEqual(['a-result.json', 'b-result.json'])
  })

  it('uploads a contract-valid batch that keeps the retry', async () => {
    const { bodies, fetchImpl } = captureFetch()
    const outcome = await runAllureUpload({
      directory: allureDirectory(),
      endpoint: 'http://api',
      token: 'fmk_x',
      env: {},
      fetchImpl,
    })

    expect(outcome.status).toBe('uploaded')
    const batch = ingestRunBatchSchema.parse(bodies[0])
    expect(batch.executions.map((execution) => [execution.attempt, execution.status])).toEqual([
      [1, 'fail'],
      [2, 'flaky'],
    ])
    expect(batch.executions[1]?.retryOfIndex).toBe(0)
  })

  it('carries FLAKEMETRY_VARIANT onto every execution', async () => {
    const { bodies, fetchImpl } = captureFetch()
    await runAllureUpload({
      directory: allureDirectory(),
      endpoint: 'http://api',
      token: 'fmk_x',
      env: { FLAKEMETRY_VARIANT: 'ios' },
      fetchImpl,
    })
    const batch = ingestRunBatchSchema.parse(bodies[0])
    expect(batch.executions.every((execution) => execution.params?.variant === 'ios')).toBe(true)
  })

  it('fails plainly when the directory is missing', async () => {
    const outcome = await runAllureUpload({
      directory: '/does/not/exist',
      endpoint: 'http://api',
      token: 'fmk_x',
      env: {},
    })
    expect(outcome.status).toBe('failed')
  })

  it('skips without endpoint or token', async () => {
    const outcome = await runAllureUpload({
      directory: allureDirectory(),
      endpoint: '',
      token: 'fmk_x',
      env: {},
    })
    expect(outcome.status).toBe('skipped')
  })
})

describe('flakemetry xcresult', () => {
  const summary = JSON.stringify({
    testNodes: [
      {
        nodeType: 'Test Suite',
        name: 'AuthFlowUITests',
        children: [{ nodeType: 'Test Case', name: 'test_a()', result: 'Passed' }],
      },
    ],
  })

  it('uploads a contract-valid batch', async () => {
    const { bodies, fetchImpl } = captureFetch()
    const outcome = await runXcresultUpload({
      file: 'x.json',
      endpoint: 'http://api',
      token: 'fmk_x',
      env: {},
      fetchImpl,
      readFile: () => summary,
      fileExists: () => true,
    })

    expect(outcome.status).toBe('uploaded')
    expect(ingestRunBatchSchema.parse(bodies[0]).executions[0]?.title).toBe('test_a')
  })

  it('fails plainly on a file that is not JSON', async () => {
    const outcome = await runXcresultUpload({
      file: 'x.json',
      endpoint: 'http://api',
      token: 'fmk_x',
      env: {},
      readFile: () => '<not json>',
      fileExists: () => true,
    })
    expect(outcome.status).toBe('failed')
  })
})
