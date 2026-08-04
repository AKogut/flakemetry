import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import { getIngestionHealth } from '../ingestion'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seedProject = async () => {
  const slug = `ingest-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  return { orgId: org.id, projectId: project.id }
}

const job = async (
  tenant: { orgId: string; projectId: string },
  status: 'pending' | 'processing' | 'done' | 'dead',
  lastError?: string,
) =>
  prisma.ingestionJob.create({
    data: {
      ...tenant,
      idempotencyKey: randomUUID(),
      payload: {},
      status,
      attempts: status === 'dead' ? 5 : 1,
      lastError: lastError ?? null,
    },
  })

describe.skipIf(!hasDb)('getIngestionHealth', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reports nothing when every batch was processed', async () => {
    const tenant = await seedProject()
    await job(tenant, 'done')
    await job(tenant, 'pending')

    expect(await getIngestionHealth(prisma, tenant.projectId)).toEqual({ failed: 0, recent: [] })
  })

  it('reports batches that exhausted their retries, with the reason', async () => {
    const tenant = await seedProject()
    await job(tenant, 'done')
    await job(tenant, 'dead', 'Transaction already closed')

    const health = await getIngestionHealth(prisma, tenant.projectId)

    expect(health.failed).toBe(1)
    expect(health.recent[0]?.lastError).toBe('Transaction already closed')
    expect(health.recent[0]?.attempts).toBe(5)
  })

  it('does not leak another project failures', async () => {
    const mine = await seedProject()
    const theirs = await seedProject()
    await job(theirs, 'dead', 'not mine')

    // Instances hold several projects, so a failure banner sourced from the wrong tenant
    // would both mislead and disclose.
    expect(await getIngestionHealth(prisma, mine.projectId)).toEqual({ failed: 0, recent: [] })
    expect((await getIngestionHealth(prisma, theirs.projectId)).failed).toBe(1)
  })

  it('caps how many it returns while still counting them all', async () => {
    const tenant = await seedProject()
    for (let index = 0; index < 7; index += 1) await job(tenant, 'dead', `boom ${index}`)

    const health = await getIngestionHealth(prisma, tenant.projectId, 3)

    expect(health.failed).toBe(7)
    expect(health.recent).toHaveLength(3)
  })
})
