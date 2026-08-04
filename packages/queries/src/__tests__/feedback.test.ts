import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildEvalSetFromFeedback, getRcaFeedback, recordRcaFeedback } from '../feedback'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seed = async () => {
  const suffix = randomUUID()
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${suffix}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${suffix}` },
  })
  const tenant = { orgId: org.id, projectId: project.id }
  const user = await prisma.user.create({
    data: { name: 'reviewer', email: `reviewer-${suffix}@example.test` },
  })
  const identity = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: `fp-${suffix}`,
      filePath: 'a.spec.ts',
      suite: 'api',
      title: 'creates an order',
    },
  })
  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: `run-${suffix}`,
      commitSha: 'abc1234',
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'failed',
      startedAt: new Date('2026-07-01T10:00:00Z'),
    },
  })
  const signature = await prisma.errorSignature.create({
    data: { ...tenant, normalizedHash: `h-${suffix}`, sampleMessage: '422', stackTemplate: '' },
  })
  const execution = await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run.id,
      testIdentityId: identity.id,
      errorSignatureId: signature.id,
      attempt: 1,
      status: 'fail',
      durationMs: 400,
      errorMessage: 'apiRequestContext.post: 422 Unprocessable Entity',
      startedAt: new Date('2026-07-01T10:00:01Z'),
    },
  })
  const report = await prisma.rcaReport.create({
    data: {
      ...tenant,
      executionId: execution.id,
      signatureId: signature.id,
      summary: 'network flake',
      likelyCause: 'slow upstream',
      suggestedAction: 'add retry',
      confidence: 0.5,
      similarPast: [],
      llmModel: 'fake',
      tokenCost: 10,
    },
  })
  return { ...tenant, userId: user.id, reportId: report.id }
}

describe.skipIf(!hasDb)('rca feedback', () => {
  beforeEach(async () => {
    await prisma.rcaFeedback.deleteMany()
    await prisma.rcaReport.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.errorSignature.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('replaces a verdict rather than stacking a second one', async () => {
    const ctx = await seed()
    await recordRcaFeedback(prisma, { ...ctx, verdict: 'helpful' })
    await recordRcaFeedback(prisma, { ...ctx, verdict: 'unhelpful', correction: 'missing header' })

    // One reviewer clicking twice must not weight the eval set twice.
    expect(await prisma.rcaFeedback.count()).toBe(1)
    const stored = await getRcaFeedback(prisma, ctx.reportId, ctx.userId)
    expect(stored?.verdict).toBe('unhelpful')
    expect(stored?.correction).toBe('missing header')
  })

  it('refuses a report belonging to another project', async () => {
    const mine = await seed()
    const theirs = await seed()

    await expect(
      recordRcaFeedback(prisma, { ...theirs, reportId: mine.reportId, verdict: 'helpful' }),
    ).rejects.toThrow(/does not belong/)
  })

  it('builds eval cases only from feedback that says what right looks like', async () => {
    const ctx = await seed()
    await recordRcaFeedback(prisma, { ...ctx, verdict: 'unhelpful' })

    // A bare thumbs-down carries no expectation to score against.
    expect(await buildEvalSetFromFeedback(prisma, ctx.projectId)).toEqual([])

    await recordRcaFeedback(prisma, {
      ...ctx,
      verdict: 'unhelpful',
      correction: 'The orders endpoint requires an idempotency header',
    })

    const cases = await buildEvalSetFromFeedback(prisma, ctx.projectId)
    expect(cases).toHaveLength(1)
    expect(cases[0]?.input.testTitle).toBe('creates an order')
    expect(cases[0]?.expect.causeKeywords).toContain('idempotency')
    expect(cases[0]?.expect.causeKeywords).not.toContain('the')
  })
})
