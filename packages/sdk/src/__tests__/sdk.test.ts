import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ingestRunBatchSchema,
  otlpToIngestBatch,
  otlpTraceRequestSchema,
} from '@flakemetry/contracts'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IngestClient } from '../client'
import { RESOURCE_ATTR, SPAN_ATTR, SPAN_NAMES } from '../conventions'
import { exportRunOverOtlp } from '../exporter'
import { computeFingerprint, hashParams, normalizeFilePath } from '../fingerprint'
import { type RunContext, TestRunRecorder } from '../recorder'
import { shouldDeliverRun } from '../sampling'
import { emitRunSpans } from '../spans'

const context: RunContext = {
  project: 'acme/web',
  commitSha: 'a1b2c3d',
  branch: 'main',
  ciProvider: 'github_actions',
  trigger: 'push',
  ciRunId: '9000001',
}

const makeRecorder = () => {
  const recorder = new TestRunRecorder(context)
  recorder.startRun(new Date('2026-07-16T10:00:00Z'))
  recorder.record({
    filePath: 'e2e/auth/login.spec.ts',
    suite: 'auth',
    title: 'logs in',
    status: 'fail',
    attempt: 1,
    startedAt: new Date('2026-07-16T10:00:01Z'),
    durationMs: 1800,
    error: { type: 'TimeoutError', message: 'Timeout 30000ms exceeded', stack: 'at login:12' },
  })
  recorder.record({
    filePath: 'e2e/auth/login.spec.ts',
    suite: 'auth',
    title: 'logs in',
    status: 'flaky',
    attempt: 2,
    retryOfIndex: 0,
    startedAt: new Date('2026-07-16T10:00:03Z'),
    durationMs: 1400,
  })
  recorder.finishRun('failed', new Date('2026-07-16T10:00:05Z'))
  return recorder
}

describe('fingerprint', () => {
  it('normalizes paths so os and prefix differences do not fork identity', () => {
    expect(normalizeFilePath('.\\E2E\\Auth\\Login.spec.ts')).toBe('e2e/auth/login.spec.ts')
  })

  it('is stable for the same test and distinct for a different title', () => {
    const a = computeFingerprint({ filePath: 'a.spec.ts', suite: 's', title: 'does x' })
    const b = computeFingerprint({ filePath: 'a.spec.ts', suite: 's', title: 'does x' })
    const c = computeFingerprint({ filePath: 'a.spec.ts', suite: 's', title: 'does y' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('sha256:')).toBe(true)
  })

  it('hashes params order-independently', () => {
    expect(hashParams({ b: 2, a: 1 })).toBe(hashParams({ a: 1, b: 2 }))
    expect(hashParams({})).toBeNull()
    expect(hashParams(null)).toBeNull()
  })
})

describe('recorder to ingest batch', () => {
  it('builds a contract-valid batch with computed fingerprints and retry linkage', () => {
    const batch = makeRecorder().toIngestBatch('gh-9000001-1')
    expect(batch.executions).toHaveLength(2)
    expect(batch.resource.commitSha).toBe('a1b2c3d')
    expect(batch.run.status).toBe('failed')
    expect(batch.executions[1]?.retryOfIndex).toBe(0)
  })

  it('assigns the same identity to both attempts of the same test', () => {
    const recorder = makeRecorder()
    const [first, second] = recorder.recorded
    expect(first?.fingerprint).toBe(second?.fingerprint)
  })
})

describe('otel spans', () => {
  it('emits a run span parenting one case span per attempt with convention attributes', () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    const tracer = provider.getTracer('test')

    emitRunSpans(tracer, makeRecorder())

    const spans = exporter.getFinishedSpans()
    const runSpan = spans.find((s) => s.name === SPAN_NAMES.run)
    const caseSpans = spans.filter((s) => s.name === SPAN_NAMES.case)

    expect(runSpan).toBeDefined()
    expect(caseSpans).toHaveLength(2)
    expect(runSpan?.attributes[RESOURCE_ATTR.project]).toBe('acme/web')
    expect(caseSpans[0]?.attributes[SPAN_ATTR.suite]).toBe('auth')
    expect(caseSpans[0]?.attributes[SPAN_ATTR.fingerprint]).toContain('sha256:')
    expect(
      caseSpans.every((s) => s.parentSpanContext?.spanId === runSpan?.spanContext().spanId),
    ).toBe(true)
    expect(caseSpans[0]?.events[0]?.name).toBe('exception')
  })
})

describe('ingest client', () => {
  it('sends the batch with auth and idempotency headers and parses the ack', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      }
      return new Response(JSON.stringify({ receiptId: 'r1', acceptedExecutions: 2 }), {
        status: 202,
      })
    }) as unknown as typeof fetch

    const client = new IngestClient({
      endpoint: 'https://ingest.test/',
      token: 'fmk_secret',
      fetchImpl,
    })
    const result = await client.send(makeRecorder().toIngestBatch('gh-9000001-1'))

    expect(result.ok).toBe(true)
    expect(result.ack?.acceptedExecutions).toBe(2)
    expect(seen!.url).toBe('https://ingest.test/v1/ingest')
    expect(seen!.headers.authorization).toBe('Bearer fmk_secret')
    expect(seen!.headers['idempotency-key']).toBe('gh-9000001-1')
  })

  it('fails open on a network error instead of throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const client = new IngestClient({ endpoint: 'https://ingest.test', token: 't', fetchImpl })
    const result = await client.send(makeRecorder().toIngestBatch('k12345678'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })
})

describe('otlp exporter round-trip', () => {
  let server: Server
  let received: { authorization?: string; body: unknown } | null = null

  beforeEach(async () => {
    received = null
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received = {
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('emits OTLP the ingest mapper accepts as a contract-valid batch', async () => {
    const port = (server.address() as AddressInfo).port
    await exportRunOverOtlp(makeRecorder(), 'gh-9000001-1', {
      endpoint: `http://127.0.0.1:${port}`,
      token: 'fmk_secret',
    })

    expect(received).not.toBeNull()
    expect(received!.authorization).toBe('Bearer fmk_secret')

    const otlp = otlpTraceRequestSchema.parse(received!.body)
    const batch = ingestRunBatchSchema.parse(otlpToIngestBatch(otlp))

    expect(batch.idempotencyKey).toBe('gh-9000001-1')
    expect(batch.resource.commitSha).toBe('a1b2c3d')
    expect(batch.resource.trigger).toBe('push')
    expect(batch.run.status).toBe('failed')
    expect(batch.executions).toHaveLength(2)
    expect(batch.executions[1]?.retryOfIndex).toBe(0)
    expect(batch.executions[0]?.error?.message).toBe('Timeout 30000ms exceeded')
  })
})

describe('run sampling', () => {
  const passing = () => {
    const recorder = new TestRunRecorder(context)
    recorder.startRun(new Date('2026-07-16T10:00:00Z'))
    recorder.record({
      filePath: 'e2e/home.spec.ts',
      suite: 'home',
      title: 'renders',
      status: 'pass',
      attempt: 1,
      startedAt: new Date('2026-07-16T10:00:01Z'),
      durationMs: 800,
    })
    recorder.finishRun('passed', new Date('2026-07-16T10:00:02Z'))
    return recorder.toIngestBatch('pass-000001')
  }

  it('always delivers at full sample rate', () => {
    expect(shouldDeliverRun(passing(), { sampleRate: 1 })).toBe(true)
  })

  it('always delivers runs that contain a failure regardless of rate', () => {
    const failing = makeRecorder().toIngestBatch('fail-000001')
    expect(shouldDeliverRun(failing, { sampleRate: 0, rng: () => 0.99 })).toBe(true)
  })

  it('samples passing runs by the configured rate', () => {
    expect(shouldDeliverRun(passing(), { sampleRate: 0.5, rng: () => 0.4 })).toBe(true)
    expect(shouldDeliverRun(passing(), { sampleRate: 0.5, rng: () => 0.6 })).toBe(false)
  })
})

describe('buffer flush-later', () => {
  let server: Server
  let mode: 'ok' | 'fail'

  beforeEach(async () => {
    mode = 'ok'
    server = createServer((req, res) => {
      req.on('data', () => undefined)
      req.on('end', () => {
        if (mode === 'fail') {
          res.writeHead(500)
          res.end('nope')
          return
        }
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ receiptId: 'r1', acceptedExecutions: 2 }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('buffers a failed send and replays it on the next flush', async () => {
    const port = (server.address() as AddressInfo).port
    const bufferDir = mkdtempSync(join(tmpdir(), 'flakemetry-buffer-'))
    const client = new IngestClient({
      endpoint: `http://127.0.0.1:${port}`,
      token: 't',
      bufferDir,
    })

    mode = 'fail'
    const result = await client.send(makeRecorder().toIngestBatch('run-000001'))
    expect(result.ok).toBe(false)
    expect(result.buffered).toBe(true)
    expect(readdirSync(bufferDir)).toHaveLength(1)

    mode = 'ok'
    const flush = await client.flushBuffered()
    expect(flush.flushed).toBe(1)
    expect(flush.remaining).toBe(0)
    expect(existsSync(bufferDir) ? readdirSync(bufferDir) : []).toHaveLength(0)
  })

  it('keeps buffered runs when the flush still fails', async () => {
    const port = (server.address() as AddressInfo).port
    const bufferDir = mkdtempSync(join(tmpdir(), 'flakemetry-buffer-'))
    const client = new IngestClient({
      endpoint: `http://127.0.0.1:${port}`,
      token: 't',
      bufferDir,
    })

    mode = 'fail'
    await client.send(makeRecorder().toIngestBatch('run-000001'))
    const flush = await client.flushBuffered()
    expect(flush.flushed).toBe(0)
    expect(flush.remaining).toBe(1)
    expect(readdirSync(bufferDir)).toHaveLength(1)
  })
})
