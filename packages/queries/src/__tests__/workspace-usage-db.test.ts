import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { getWorkspaceUsage } from '../workspace-usage'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const seedProject = async (orgId: string, name: string, executions: number) => {
  const project = await prisma.project.create({
    data: { orgId, name, slug: `${name.toLowerCase()}-${Math.random()}` },
  })
  const tenant = { orgId, projectId: project.id }
  const identity = await prisma.testIdentity.create({
    data: { ...tenant, fingerprint: `fp-${Math.random()}`, filePath: 'a', suite: 's', title: 't' },
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
        startedAt: new Date(Date.UTC(2026, 8, 1 + index)),
      },
    })
    await prisma.testExecution.create({
      data: {
        ...tenant,
        runId: run.id,
        testIdentityId: identity.id,
        attempt: 1,
        status: 'pass',
        durationMs: 10,
        startedAt: new Date(Date.UTC(2026, 8, 1 + index)),
      },
    })
  }
  return project.id
}

describe.skipIf(!hasDb)('getWorkspaceUsage', () => {
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

  it('reports every project of the requested workspaces, and only those', async () => {
    const mine = await prisma.org.create({ data: { name: 'Mine', slug: `mine-${Date.now()}` } })
    const theirs = await prisma.org.create({ data: { name: 'Theirs', slug: `th-${Date.now()}` } })
    const web = await seedProject(mine.id, 'Web', 3)
    await seedProject(mine.id, 'Api', 1)
    await seedProject(theirs.id, 'Secret', 2)

    const rows = await getWorkspaceUsage(prisma, [mine.id], { env: {} })

    expect(rows.map((row) => row.projectName)).toEqual(['Api', 'Web'])
    expect(rows.find((row) => row.projectId === web)?.usage.rows.executions).toBe(3)
  })

  it('flags a project over its execution cap, from the policy or the environment', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const capped = await seedProject(org.id, 'Capped', 3)
    await prisma.projectPolicy.create({
      data: { orgId: org.id, projectId: capped, storageMaxExecutions: 2 },
    })
    const roomy = await seedProject(org.id, 'Roomy', 3)

    const fromPolicy = await getWorkspaceUsage(prisma, [org.id], { env: {} })
    expect(fromPolicy.find((row) => row.projectId === capped)).toMatchObject({
      overExecutionCap: true,
      caps: { storageMaxExecutions: 2 },
    })
    expect(fromPolicy.find((row) => row.projectId === roomy)?.overExecutionCap).toBe(false)

    const fromEnv = await getWorkspaceUsage(prisma, [org.id], {
      env: { FLAKEMETRY_STORAGE_MAX_EXECUTIONS: '1' },
    })
    expect(fromEnv.every((row) => row.overExecutionCap)).toBe(true)
  })

  it('returns nothing for no workspaces rather than every project', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    await seedProject(org.id, 'Web', 1)
    expect(await getWorkspaceUsage(prisma, [])).toEqual([])
  })
})
