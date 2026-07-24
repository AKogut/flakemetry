import type { IngestRunBatch } from '@flakemetry/contracts'
import { PrismaClient } from '@flakemetry/db'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadScoringPolicy } from '../policy'
import { processJob } from '../processor'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-07-16T12:00:00Z')

const seedProject = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${Date.now()}` },
  })
  return { orgId: org.id, projectId: project.id }
}

const flakyBatch = (): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: `run-${Date.now()}`,
  resource: { ciProvider: 'github_actions', commitSha: 'abc1234', branch: 'main', trigger: 'push' },
  run: { status: 'failed', startedAt: new Date('2026-07-16T10:00:00Z') },
  executions: [
    {
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'fail',
      attempt: 1,
      startedAt: new Date('2026-07-16T10:00:01Z'),
      durationMs: 1800,
      error: { message: 'Timeout 30000ms exceeded' },
    },
    {
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'flaky',
      attempt: 2,
      retryOfIndex: 0,
      startedAt: new Date('2026-07-16T10:00:03Z'),
      durationMs: 1400,
    },
  ],
})

describe.skipIf(!hasDb)('per-project scoring policy', () => {
  beforeEach(async () => {
    await prisma.policyChange.deleteMany()
    await prisma.projectPolicy.deleteMany()
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterEach(() => {
    delete process.env.FLAKEMETRY_FLAKY_THRESHOLD
    delete process.env.FLAKEMETRY_FLAKY_MIN_SAMPLES
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('defaults to 0.8 / 5 when no policy row exists', async () => {
    const { projectId } = await seedProject()
    expect(await loadScoringPolicy(prisma, projectId)).toEqual({ threshold: 0.8, minSamples: 5 })
  })

  it('reads a stored UI policy row', async () => {
    const { orgId, projectId } = await seedProject()
    await prisma.projectPolicy.create({
      data: { projectId, orgId, flakyThreshold: 0.5, minSamples: 2 },
    })
    expect(await loadScoringPolicy(prisma, projectId)).toEqual({ threshold: 0.5, minSamples: 2 })
  })

  it('lets an env override win over the stored row', async () => {
    const { orgId, projectId } = await seedProject()
    await prisma.projectPolicy.create({
      data: { projectId, orgId, flakyThreshold: 0.5, minSamples: 2 },
    })
    process.env.FLAKEMETRY_FLAKY_THRESHOLD = '0.99'
    expect(await loadScoringPolicy(prisma, projectId)).toEqual({ threshold: 0.99, minSamples: 2 })
  })

  it('a lower stored threshold makes a test a quarantine candidate on the next run', async () => {
    const { orgId, projectId } = await seedProject()
    await prisma.projectPolicy.create({
      data: { projectId, orgId, flakyThreshold: 0.01, minSamples: 1 },
    })

    const policy = await loadScoringPolicy(prisma, projectId)
    await processJob(prisma, flakyBatch(), {
      orgId,
      projectId,
      now: NOW,
      threshold: policy.threshold,
      minSamples: policy.minSamples,
    })

    const score = await prisma.flakyScore.findFirstOrThrow({ where: { projectId } })
    expect(score.quarantineCandidate).toBe(true)
  })

  it('a high stored threshold keeps the same test off the candidate list', async () => {
    const { orgId, projectId } = await seedProject()
    await prisma.projectPolicy.create({
      data: { projectId, orgId, flakyThreshold: 0.99, minSamples: 1 },
    })

    const policy = await loadScoringPolicy(prisma, projectId)
    await processJob(prisma, flakyBatch(), {
      orgId,
      projectId,
      now: NOW,
      threshold: policy.threshold,
      minSamples: policy.minSamples,
    })

    const score = await prisma.flakyScore.findFirstOrThrow({ where: { projectId } })
    expect(score.quarantineCandidate).toBe(false)
  })
})
