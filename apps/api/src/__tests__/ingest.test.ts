import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const validBatch = (idempotencyKey: string) => ({
  contractVersion: '0.1.0',
  idempotencyKey,
  resource: {
    ciProvider: 'github_actions',
    commitSha: 'abc1234',
    branch: 'main',
    trigger: 'push',
  },
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

const seedToken = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'ci', tokenHash: hashToken(raw) },
  })
  return { raw, projectId: project.id }
}

describe.skipIf(!hasDb)('POST /v1/ingest', () => {
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

  it('returns healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', service: 'api' })
  })

  it('rejects a missing or invalid token with 401', async () => {
    const noAuth = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: validBatch('k1'),
    })
    expect(noAuth.statusCode).toBe(401)

    const badAuth = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: 'Bearer fmk_wrong' },
      payload: validBatch('k1'),
    })
    expect(badAuth.statusCode).toBe(401)
  })

  it('rejects an invalid payload with 400 and issue paths', async () => {
    const { raw } = await seedToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${raw}` },
      payload: { ...validBatch('k2'), idempotencyKey: 'x' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_payload')
    expect(res.json().issues[0].path).toBe('idempotencyKey')
  })

  it('accepts a valid batch with 202 and enqueues exactly one job', async () => {
    const { raw, projectId } = await seedToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${raw}` },
      payload: validBatch('run-000042'),
    })

    expect(res.statusCode).toBe(202)
    expect(res.json().acceptedExecutions).toBe(1)
    expect(res.json().deduplicated).toBe(false)

    const jobs = await prisma.ingestionJob.findMany({ where: { projectId } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.idempotencyKey).toBe('run-000042')
  })

  it('deduplicates a re-delivered batch without double-enqueuing', async () => {
    const { raw, projectId } = await seedToken()
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/ingest',
        headers: { authorization: `Bearer ${raw}` },
        payload: validBatch('run-dup-01'),
      })

    const first = await send()
    const second = await send()

    expect(first.json().deduplicated).toBe(false)
    expect(second.json().deduplicated).toBe(true)
    expect(second.json().receiptId).toBe(first.json().receiptId)
    expect(await prisma.ingestionJob.count({ where: { projectId } })).toBe(1)
  })
})
