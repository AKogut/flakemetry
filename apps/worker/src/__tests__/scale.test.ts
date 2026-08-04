import { randomUUID } from 'node:crypto'

import type { IngestRunBatch } from '@flakemetry/contracts'
import { PrismaClient } from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import { processJob } from '../processor'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-08-04T12:00:00Z')
const STARTED_AT = new Date('2026-08-04T10:00:00Z')

const seedProject = async () => {
  const slug = `scale-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  return { orgId: org.id, projectId: project.id }
}

const suiteOf = (size: number): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: randomUUID(),
  resource: {
    ciProvider: 'github_actions',
    commitSha: 'abc1234',
    branch: 'main',
    trigger: 'push',
  },
  run: { status: 'passed', startedAt: STARTED_AT },
  executions: Array.from({ length: size }, (_, index) => ({
    filePath: `src/feature-${index % 200}.spec.ts`,
    suite: `feature ${index % 200}`,
    title: `case ${index}`,
    status: 'pass' as const,
    attempt: 1,
    startedAt: STARTED_AT,
    durationMs: 12,
  })),
})

/**
 * A real suite is thousands of tests, and the contract accepts up to 5000 in one batch.
 * Writing them a statement at a time overran Prisma's five-second interactive transaction
 * limit, so the API accepted the run with a 202 and the worker then failed it permanently —
 * the run never appeared and nothing surfaced to the user. Size here is the whole point of
 * the test: anything small enough to be quick passes with or without the batching.
 */
describe.skipIf(!hasDb)('full-suite ingestion', { timeout: 300_000 }, () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('persists a suite far larger than one transaction of per-test statements', async () => {
    const { orgId, projectId } = await seedProject()
    const batch = suiteOf(3000)

    const result = await processJob(prisma, batch, { orgId, projectId, now: NOW, aiEnabled: false })

    expect(result.executions).toBe(3000)
    expect(result.newIdentities).toBe(3000)
    expect(await prisma.testExecution.count({ where: { projectId } })).toBe(3000)
    expect(await prisma.testIdentity.count({ where: { projectId } })).toBe(3000)
  })

  it('reprocessing the same batch keeps execution ids stable', async () => {
    const { orgId, projectId } = await seedProject()
    const batch = suiteOf(1200)
    const ctx = { orgId, projectId, now: NOW, aiEnabled: false }

    await processJob(prisma, batch, ctx)
    const before = await prisma.testExecution.findMany({
      where: { projectId },
      select: { id: true, ordinal: true },
      orderBy: { ordinal: 'asc' },
    })

    await processJob(prisma, batch, ctx)
    const after = await prisma.testExecution.findMany({
      where: { projectId },
      select: { id: true, ordinal: true },
      orderBy: { ordinal: 'asc' },
    })

    // RCA reports and artifacts reference execution ids. Replaying a batch — which the queue
    // does on any retry — must not renumber them, or those references dangle.
    expect(after).toEqual(before)
    expect(await prisma.testExecution.count({ where: { projectId } })).toBe(1200)
  })
})
