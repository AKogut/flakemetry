import { gzipSync } from 'node:zlib'

import { RESOURCE_ATTR, SPAN_ATTR, SPAN_NAMES } from '@flakemetry/contracts'
import { generateToken, hashToken, IngestionQueue, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const validBatch = (idempotencyKey: string) => ({
  contractVersion: '0.1.0',
  idempotencyKey,
  resource: { ciProvider: 'github_actions', commitSha: 'abc1234', branch: 'main', trigger: 'push' },
  run: { status: 'passed', startedAt: '2026-07-16T10:00:00Z' },
  executions: [
    {
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'pass',
      attempt: 1,
      startedAt: '2026-07-16T10:00:01Z',
      durationMs: 1200,
    },
  ],
})

const s = (value: string) => ({ stringValue: value })
const i = (value: number) => ({ intValue: String(value) })
const RUN_START = Date.parse('2026-07-16T10:00:00Z') * 1_000_000
const nano = (ms: number) => String(RUN_START + ms * 1_000_000)

const otlpRequest = (idempotencyKey: string) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: RESOURCE_ATTR.project, value: s('web') },
          { key: RESOURCE_ATTR.commitSha, value: s('abc1234') },
          { key: RESOURCE_ATTR.branch, value: s('main') },
          { key: RESOURCE_ATTR.ciProvider, value: s('github_actions') },
          { key: RESOURCE_ATTR.trigger, value: s('push') },
          { key: RESOURCE_ATTR.idempotencyKey, value: s(idempotencyKey) },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'a'.repeat(32),
              spanId: 'b'.repeat(16),
              name: SPAN_NAMES.run,
              startTimeUnixNano: nano(0),
              endTimeUnixNano: nano(5000),
              status: { code: 1 },
            },
            {
              traceId: 'a'.repeat(32),
              spanId: 'c'.repeat(16),
              parentSpanId: 'b'.repeat(16),
              name: SPAN_NAMES.case,
              startTimeUnixNano: nano(10),
              endTimeUnixNano: nano(1810),
              attributes: [
                { key: SPAN_ATTR.fingerprint, value: s('fp-login') },
                { key: SPAN_ATTR.title, value: s('logs in') },
                { key: SPAN_ATTR.filePath, value: s('e2e/login.spec.ts') },
                { key: SPAN_ATTR.status, value: s('pass') },
                { key: SPAN_ATTR.attempt, value: i(1) },
                { key: SPAN_ATTR.durationMs, value: i(1800) },
              ],
            },
          ],
        },
      ],
    },
  ],
})

const seedToken = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'ci', tokenHash: hashToken(raw) },
  })
  return { raw }
}

describe.skipIf(!hasDb)('api hardening', () => {
  beforeEach(async () => {
    await prisma.ingestionJob.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('rate limits a token beyond the configured window', async () => {
    const { raw } = await seedToken()
    const app = buildApp({ prisma, rateLimit: { max: 1, windowMs: 60_000 } })
    const send = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/ingest',
        headers: { authorization: `Bearer ${raw}` },
        payload: validBatch(key),
      })

    expect((await send('run-000001')).statusCode).toBe(202)
    const limited = await send('run-000002')
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('sheds load with 503 when the queue depth exceeds the limit', async () => {
    const { raw } = await seedToken()
    const app = buildApp({ prisma, maxQueueDepth: 1, depthCacheMs: 0 })
    const send = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/ingest',
        headers: { authorization: `Bearer ${raw}` },
        payload: validBatch(key),
      })

    expect((await send('run-000001')).statusCode).toBe(202)
    const shed = await send('run-000002')
    expect(shed.statusCode).toBe(503)
    expect(shed.headers['retry-after']).toBeDefined()
  })

  it('caches queue depth instead of counting on every request', async () => {
    const { raw } = await seedToken()
    const queue = new IngestionQueue(prisma)
    let depthCalls = 0
    const countingQueue = Object.assign(Object.create(Object.getPrototypeOf(queue)), queue, {
      depth: async () => {
        depthCalls += 1
        return 0
      },
    }) as IngestionQueue

    const app = buildApp({ prisma, queue: countingQueue, maxQueueDepth: 100, depthCacheMs: 60_000 })
    for (const key of ['run-000001', 'run-000002', 'run-000003']) {
      await app.inject({
        method: 'POST',
        url: '/v1/ingest',
        headers: { authorization: `Bearer ${raw}` },
        payload: validBatch(key),
      })
    }

    expect(depthCalls).toBe(1)
  })

  it('decompresses gzip-encoded OTLP request bodies', async () => {
    const { raw } = await seedToken()
    const app = buildApp({ prisma })
    const body = gzipSync(Buffer.from(JSON.stringify(otlpRequest('run-000001'))))

    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: {
        authorization: `Bearer ${raw}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    expect(await prisma.ingestionJob.count()).toBe(1)
  })
})
