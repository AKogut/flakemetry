import { describe, expect, it, vi } from 'vitest'

import { runUpload } from '../commands/upload'

const validBatchJson = JSON.stringify({
  contractVersion: '0.1.0',
  idempotencyKey: 'run-000001',
  resource: { ciProvider: 'github_actions', commitSha: 'abc1234', branch: 'main', trigger: 'push' },
  run: { status: 'failed', startedAt: '2026-07-16T10:00:00.000Z' },
  executions: [
    {
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'fail',
      attempt: 1,
      startedAt: '2026-07-16T10:00:01.000Z',
      durationMs: 1800,
      error: { message: 'Timeout 30000ms exceeded' },
    },
  ],
})

const okFetch = (): typeof fetch =>
  vi.fn(async () => ({
    ok: true,
    status: 202,
    json: async () => ({ receiptId: 'receipt-1', acceptedExecutions: 1 }),
  })) as unknown as typeof fetch

const withFile = (contents: string) => ({
  readFile: () => contents,
  fileExists: () => true,
})

describe('runUpload', () => {
  it('skips when endpoint or token is missing', async () => {
    const outcome = await runUpload({
      file: 'r.json',
      endpoint: '',
      token: 'fmk_x',
      ...withFile(validBatchJson),
    })
    expect(outcome.status).toBe('skipped')
  })

  it('fails when the results file is absent', async () => {
    const outcome = await runUpload({
      file: 'missing.json',
      endpoint: 'http://api',
      token: 'fmk_x',
      fileExists: () => false,
      readFile: () => '',
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('not found')
  })

  it('fails on malformed JSON', async () => {
    const outcome = await runUpload({
      file: 'r.json',
      endpoint: 'http://api',
      token: 'fmk_x',
      ...withFile('{ not json'),
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('could not parse')
  })

  it('fails when the payload does not match the ingest schema', async () => {
    const outcome = await runUpload({
      file: 'r.json',
      endpoint: 'http://api',
      token: 'fmk_x',
      ...withFile(JSON.stringify({ contractVersion: '0.1.0' })),
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('invalid results file')
  })

  it('uploads a valid batch and returns the receipt', async () => {
    const fetchImpl = okFetch()
    const outcome = await runUpload({
      file: 'r.json',
      endpoint: 'http://api',
      token: 'fmk_secret',
      fetchImpl,
      ...withFile(validBatchJson),
    })
    expect(outcome).toMatchObject({
      status: 'uploaded',
      receiptId: 'receipt-1',
      acceptedExecutions: 1,
    })

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { headers: Record<string, string> },
    ][]
    const call = calls[0]!
    expect(call[0]).toBe('http://api/v1/ingest')
    expect(call[1].headers.authorization).toBe('Bearer fmk_secret')
    expect(call[1].headers['idempotency-key']).toBe('run-000001')
  })

  it('reports a failed upload when the API rejects it', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch
    const outcome = await runUpload({
      file: 'r.json',
      endpoint: 'http://api',
      token: 'fmk_x',
      fetchImpl,
      ...withFile(validBatchJson),
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('401')
  })
})
