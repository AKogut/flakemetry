import { createPrismaClient, refreshRunCounts } from '@flakemetry/db'
import { createMemoryObjectStore, projectArtifactPrefix } from '@flakemetry/storage'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  MEGABYTE,
  parseRetentionGlobals,
  resolveRetentionPlan,
  runRetentionSweep,
} from '../retention'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()
const NOW = new Date('2026-07-30T12:00:00Z')
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

describe('resolveRetentionPlan', () => {
  const globals = { executionDays: 30, artifactDays: 60 }

  it('prefers a per-project override over the global default', () => {
    const plan = resolveRetentionPlan(
      { projectId: 'p', orgId: 'o', executionRetentionDays: 7, artifactRetentionDays: null },
      globals,
    )
    expect(plan.executionDays).toBe(7)
    expect(plan.artifactDays).toBe(60)
  })

  it('falls back to the global default when there is no override', () => {
    const plan = resolveRetentionPlan(
      { projectId: 'p', orgId: 'o', executionRetentionDays: null, artifactRetentionDays: null },
      globals,
    )
    expect(plan.executionDays).toBe(30)
  })

  it('never lets artifacts expire before executions', () => {
    const plan = resolveRetentionPlan(
      { projectId: 'p', orgId: 'o', executionRetentionDays: 90, artifactRetentionDays: 10 },
      { executionDays: null, artifactDays: null },
    )
    expect(plan.artifactDays).toBe(90)
  })

  it('keeps artifacts forever when executions are kept forever', () => {
    const plan = resolveRetentionPlan(
      { projectId: 'p', orgId: 'o', executionRetentionDays: null, artifactRetentionDays: 30 },
      { executionDays: null, artifactDays: null },
    )
    expect(plan.executionDays).toBeNull()
    expect(plan.artifactDays).toBeNull()
  })

  it('treats missing config as "keep everything"', () => {
    const plan = resolveRetentionPlan(
      { projectId: 'p', orgId: 'o', executionRetentionDays: null, artifactRetentionDays: null },
      { executionDays: null, artifactDays: null },
    )
    expect(plan.executionDays).toBeNull()
    expect(plan.artifactDays).toBeNull()
  })
})

describe('parseRetentionGlobals', () => {
  it('reads positive day counts and ignores junk', () => {
    expect(
      parseRetentionGlobals({
        FLAKEMETRY_EXECUTION_RETENTION_DAYS: '14',
        FLAKEMETRY_ARTIFACT_RETENTION_DAYS: '0',
      }),
    ).toEqual({ executionDays: 14, artifactDays: null })
  })
})

describe.skipIf(!hasDb)('runRetentionSweep', () => {
  beforeEach(async () => {
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.projectPolicy.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const seedProjectWithOldExecution = async (retentionDays: number | null) => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Math.random()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: `web-${Math.random()}` },
    })
    const tenant = { orgId: org.id, projectId: project.id }
    if (retentionDays !== null) {
      await prisma.projectPolicy.create({
        data: { ...tenant, executionRetentionDays: retentionDays },
      })
    }
    const identity = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: `fp-${Math.random()}`,
        filePath: 'a',
        suite: 's',
        title: 't',
      },
    })
    const run = await prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: `run-${Math.random()}`,
        commitSha: 'abc1234',
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'push',
        status: 'failed',
        startedAt: daysAgo(5),
      },
    })
    await prisma.testExecution.create({
      data: {
        ...tenant,
        runId: run.id,
        testIdentityId: identity.id,
        attempt: 1,
        status: 'fail',
        durationMs: 100,
        startedAt: daysAgo(5),
      },
    })
    await refreshRunCounts(prisma, project.id)
    return project.id
  }

  it('prunes each project at its own effective window', async () => {
    const shortLived = await seedProjectWithOldExecution(1)
    const globalDefault = await seedProjectWithOldExecution(null)

    const result = await runRetentionSweep(
      prisma,
      createMemoryObjectStore(),
      { FLAKEMETRY_EXECUTION_RETENTION_DAYS: '30' },
      NOW,
    )

    expect(result.executionsPruned).toBe(1)
    expect(await prisma.testExecution.count({ where: { projectId: shortLived } })).toBe(0)
    expect(await prisma.testExecution.count({ where: { projectId: globalDefault } })).toBe(1)
  })

  const seedCappedProject = async (
    executions: number,
    policy: { storageMaxExecutions?: number; storageMaxArtifactMb?: number },
  ) => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Math.random()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: `web-${Math.random()}` },
    })
    const tenant = { orgId: org.id, projectId: project.id }
    await prisma.projectPolicy.create({ data: { ...tenant, ...policy } })
    const identity = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: `fp-${Math.random()}`,
        filePath: 'a',
        suite: 's',
        title: 't',
      },
    })
    for (let index = 0; index < executions; index += 1) {
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: `run-${Math.random()}`,
          commitSha: 'abc1234',
          branch: 'main',
          ciProvider: 'github_actions',
          trigger: 'push',
          status: 'passed',
          startedAt: daysAgo(executions - index),
        },
      })
      await prisma.testExecution.create({
        data: {
          ...tenant,
          runId: run.id,
          testIdentityId: identity.id,
          attempt: 1,
          status: 'pass',
          durationMs: 100,
          startedAt: daysAgo(executions - index),
        },
      })
    }
    await refreshRunCounts(prisma, tenant.projectId)
    return tenant
  }

  it('keeps only the newest executions when a project is over its execution cap', async () => {
    const capped = await seedCappedProject(5, { storageMaxExecutions: 3 })
    const uncapped = await seedCappedProject(5, {})

    const result = await runRetentionSweep(prisma, null, {}, NOW)

    expect(result.executionsPruned).toBe(2)
    const kept = await prisma.testExecution.findMany({
      where: { projectId: capped.projectId },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true },
    })
    expect(kept.map((row) => row.startedAt)).toEqual([daysAgo(3), daysAgo(2), daysAgo(1)])
    expect(await prisma.testExecution.count({ where: { projectId: uncapped.projectId } })).toBe(5)
  })

  it('applies an execution cap set in the environment to every project', async () => {
    const project = await seedCappedProject(4, {})

    await runRetentionSweep(prisma, null, { FLAKEMETRY_STORAGE_MAX_EXECUTIONS: '1' }, NOW)

    expect(await prisma.testExecution.count({ where: { projectId: project.projectId } })).toBe(1)
  })

  it('trims the oldest artifacts of a project over its artifact cap', async () => {
    const tenant = await seedCappedProject(0, { storageMaxArtifactMb: 1 })
    let clock = daysAgo(3)
    const store = createMemoryObjectStore({ now: () => clock })
    const prefix = projectArtifactPrefix(tenant.orgId, tenant.projectId)
    await store.put(`${prefix}run/a/0/old.png`, new Uint8Array(MEGABYTE / 2 + 1), 'image/png')
    clock = daysAgo(2)
    await store.put(`${prefix}run/b/0/new.png`, new Uint8Array(MEGABYTE / 2), 'image/png')
    await store.put(
      'org/elsewhere/project/x/run/c/0/other.png',
      new Uint8Array(MEGABYTE),
      'image/png',
    )

    const result = await runRetentionSweep(prisma, store, {}, NOW)

    expect(result.artifactsPruned).toBe(1)
    expect((await store.list(prefix)).map((object) => object.key)).toEqual([
      `${prefix}run/b/0/new.png`,
    ])
    expect(await store.list('org/elsewhere/')).toHaveLength(1)
  })
})
