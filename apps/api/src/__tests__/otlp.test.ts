import { RESOURCE_ATTR, SPAN_ATTR, SPAN_NAMES } from '@flakemetry/contracts'
import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

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
              status: { code: 2 },
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
                { key: SPAN_ATTR.suite, value: s('auth') },
                { key: SPAN_ATTR.title, value: s('logs in') },
                { key: SPAN_ATTR.filePath, value: s('e2e/login.spec.ts') },
                { key: SPAN_ATTR.status, value: s('fail') },
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
  return { raw, projectId: project.id }
}

describe.skipIf(!hasDb)('POST /v1/traces', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await prisma.ingestionJob.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    app = buildApp({ prisma })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('rejects requests without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      payload: otlpRequest('run-000001'),
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts OTLP spans and enqueues the mapped batch', async () => {
    const { raw, projectId } = await seedToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { authorization: `Bearer ${raw}` },
      payload: otlpRequest('run-000001'),
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({})

    const job = await prisma.ingestionJob.findFirstOrThrow({ where: { projectId } })
    expect(job.idempotencyKey).toBe('run-000001')
    const payload = job.payload as { executions: unknown[]; resource: { commitSha: string } }
    expect(payload.resource.commitSha).toBe('abc1234')
    expect(payload.executions).toHaveLength(1)
  })

  it('deduplicates by idempotency key', async () => {
    const { raw, projectId } = await seedToken()
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/traces',
        headers: { authorization: `Bearer ${raw}` },
        payload: otlpRequest('run-000001'),
      })
    await send()
    await send()
    expect(await prisma.ingestionJob.count({ where: { projectId } })).toBe(1)
  })

  it('rejects an OTLP payload with no run span', async () => {
    const { raw } = await seedToken()
    const req = otlpRequest('run-000001')
    req.resourceSpans[0]!.scopeSpans[0]!.spans = req.resourceSpans[0]!.scopeSpans[0]!.spans.filter(
      (span) => span.name !== SPAN_NAMES.run,
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { authorization: `Bearer ${raw}` },
      payload: req,
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).partialSuccess.errorMessage).toMatch(/test.run/)
  })
})
