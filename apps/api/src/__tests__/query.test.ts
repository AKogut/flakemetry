import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'
import type { TrpcContext } from '../trpc/context'
import { appRouter } from '../trpc/router'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const at = (iso: string) => new Date(iso)

const seed = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: 'web' },
  })
  const tenant = { orgId: org.id, projectId: project.id }

  const flakyId = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-flaky',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
    },
  })
  const stableId = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-stable',
      filePath: 'e2e/home.spec.ts',
      suite: 'home',
      title: 'renders',
    },
  })

  const run1 = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'run-000001',
      commitSha: 'aaa1111',
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'failed',
      startedAt: at('2026-07-16T10:00:00Z'),
      finishedAt: at('2026-07-16T10:05:00Z'),
      durationMs: 300000,
    },
  })
  const run2 = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'run-000002',
      commitSha: 'bbb2222',
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'passed',
      startedAt: at('2026-07-16T11:00:00Z'),
      finishedAt: at('2026-07-16T11:04:00Z'),
      durationMs: 240000,
    },
  })

  const failExec = await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run1.id,
      testIdentityId: flakyId.id,
      attempt: 1,
      status: 'fail',
      durationMs: 1800,
      errorMessage: 'Timeout 30000ms exceeded',
      startedAt: at('2026-07-16T10:00:01Z'),
    },
  })
  await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run1.id,
      testIdentityId: stableId.id,
      attempt: 1,
      status: 'pass',
      durationMs: 900,
      startedAt: at('2026-07-16T10:00:02Z'),
    },
  })
  await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run2.id,
      testIdentityId: flakyId.id,
      attempt: 1,
      status: 'pass',
      durationMs: 1700,
      startedAt: at('2026-07-16T11:00:01Z'),
    },
  })
  await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run2.id,
      testIdentityId: stableId.id,
      attempt: 1,
      status: 'pass',
      durationMs: 850,
      startedAt: at('2026-07-16T11:00:02Z'),
    },
  })

  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: flakyId.id,
      score: 0.82,
      flipRate: 0.5,
      passOnRerunRate: 0.4,
      sameShaVariance: 0.6,
      entropy: 1,
      failIsolation: 0,
      reasonCodes: [{ code: 'SAME_SHA_VARIANCE', message: 'different results' }],
      quarantineCandidate: true,
      lastFlakedAt: at('2026-07-16T10:00:01Z'),
      modelVersion: '0.1.0',
    },
  })
  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: stableId.id,
      score: 0.05,
      flipRate: 0,
      passOnRerunRate: 0,
      sameShaVariance: 0,
      entropy: 0,
      failIsolation: 0,
      reasonCodes: [],
      quarantineCandidate: false,
      modelVersion: '0.1.0',
    },
  })

  const signature = await prisma.errorSignature.create({
    data: {
      ...tenant,
      normalizedHash: 'sig-1',
      sampleMessage: 'Timeout',
      stackTemplate: 'at login',
    },
  })
  await prisma.rcaReport.create({
    data: {
      ...tenant,
      executionId: failExec.id,
      signatureId: signature.id,
      summary: 'Network flake',
      likelyCause: 'Slow upstream',
      suggestedAction: 'Add retry',
      confidence: 0.7,
      similarPast: [],
      llmModel: 'claude',
      tokenCost: 1200,
    },
  })

  return { ...tenant, run1Id: run1.id, flakyId: flakyId.id, failExecId: failExec.id }
}

const caller = (project: TrpcContext['project']) => appRouter.createCaller({ prisma, project })

describe.skipIf(!hasDb)('query api', () => {
  beforeEach(async () => {
    await prisma.rcaReport.deleteMany()
    await prisma.errorSignature.deleteMany()
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('rejects unauthenticated callers', async () => {
    await expect(
      caller(null).flaky.board({ limit: 20, minScore: 0, includeQuarantined: true }),
    ).rejects.toThrow(/token/)
  })

  it('lists runs newest-first with execution counts', async () => {
    const ctx = await seed()
    const result = await caller({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      tokenId: 't',
    }).runs.list({ limit: 20 })

    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.commitSha).toBe('bbb2222')
    expect(result.items[1]?.counts).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
    })
  })

  it('paginates runs via cursor', async () => {
    const ctx = await seed()
    const api = caller({ orgId: ctx.orgId, projectId: ctx.projectId, tokenId: 't' })
    const first = await api.runs.list({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()

    const second = await api.runs.list({ limit: 1, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
  })

  it('returns run detail with executions and rca flag', async () => {
    const ctx = await seed()
    const detail = await caller({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      tokenId: 't',
    }).run.get({ runId: ctx.run1Id })
    expect(detail.executions).toHaveLength(2)
    const failing = detail.executions.find((execution) => execution.status === 'fail')
    expect(failing?.hasRca).toBe(true)
    expect(failing?.filePath).toBe('e2e/login.spec.ts')
  })

  it('returns test detail with ordered history and reason codes', async () => {
    const ctx = await seed()
    const test = await caller({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      tokenId: 't',
    }).test.get({ testIdentityId: ctx.flakyId, historyLimit: 50 })
    expect(test.score).toBeCloseTo(0.82)
    expect(test.reasonCodes[0]?.code).toBe('SAME_SHA_VARIANCE')
    expect(test.history).toHaveLength(2)
    expect(test.history[0]?.status).toBe('fail')
    expect(test.history[1]?.status).toBe('pass')
  })

  it('ranks the flaky board by score and hides low scores when filtered', async () => {
    const ctx = await seed()
    const api = caller({ orgId: ctx.orgId, projectId: ctx.projectId, tokenId: 't' })
    const all = await api.flaky.board({ limit: 20, minScore: 0, includeQuarantined: true })
    expect(all.items[0]?.testIdentityId).toBe(ctx.flakyId)

    const filtered = await api.flaky.board({ limit: 20, minScore: 0.5, includeQuarantined: true })
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0]?.quarantineCandidate).toBe(true)
  })

  it('returns an rca report or null', async () => {
    const ctx = await seed()
    const api = caller({ orgId: ctx.orgId, projectId: ctx.projectId, tokenId: 't' })
    const report = await api.rca.get({ executionId: ctx.failExecId })
    expect(report?.likelyCause).toBe('Slow upstream')

    const missing = await api.rca.get({ executionId: ctx.flakyId })
    expect(missing).toBeNull()
  })

  it('serves the trpc router over http scoped by token', async () => {
    const ctx = await seed()
    const raw = generateToken()
    await prisma.ingestToken.create({
      data: { orgId: ctx.orgId, projectId: ctx.projectId, name: 'ci', tokenHash: hashToken(raw) },
    })
    const app = buildApp({ prisma })
    const input = encodeURIComponent(JSON.stringify({ limit: 5 }))

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/trpc/flaky.board?input=${input}`,
    })
    expect(unauthorized.statusCode).toBe(401)

    const authorized = await app.inject({
      method: 'GET',
      url: `/trpc/flaky.board?input=${input}`,
      headers: { authorization: `Bearer ${raw}` },
    })
    expect(authorized.statusCode).toBe(200)
    const body = JSON.parse(authorized.body) as { result: { data: { items: unknown[] } } }
    expect(body.result.data.items.length).toBeGreaterThan(0)

    await app.close()
  })
})
