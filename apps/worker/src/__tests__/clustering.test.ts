import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { backfillSignatureClusters } from '../clustering'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()
const NOW = new Date('2026-07-27T12:00:00Z')

const seed = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${Date.now()}` },
  })
  return { orgId: org.id, projectId: project.id }
}

const signature = async (
  tenant: { orgId: string; projectId: string },
  hash: string,
  message: string,
) => {
  await prisma.errorSignature.create({
    data: {
      ...tenant,
      normalizedHash: hash,
      sampleMessage: message,
      stackTemplate: '',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
  })
}

describe.skipIf(!hasDb)('backfillSignatureClusters', () => {
  beforeEach(async () => {
    await prisma.errorSignature.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('assigns clusters to unclustered signatures, grouping near-duplicates', async () => {
    const tenant = await seed()
    await signature(tenant, 'h1', 'Element #login is not visible in the viewport')
    await signature(tenant, 'h2', 'Element #logout is not visible in the viewport')
    await signature(tenant, 'h3', 'Request failed with status code 500 Internal Server Error')

    const assigned = await backfillSignatureClusters(prisma)
    expect(assigned).toBe(3)

    const rows = await prisma.errorSignature.findMany({
      where: { projectId: tenant.projectId },
      select: { normalizedHash: true, clusterId: true },
    })
    const clusterOf = (hash: string) => rows.find((row) => row.normalizedHash === hash)?.clusterId

    expect(clusterOf('h1')).toBeTruthy()
    expect(clusterOf('h1')).toBe(clusterOf('h2'))
    expect(clusterOf('h3')).not.toBe(clusterOf('h1'))
  })

  it('is idempotent — a second pass assigns nothing', async () => {
    const tenant = await seed()
    await signature(tenant, 'h1', 'Timeout waiting for selector to appear')

    expect(await backfillSignatureClusters(prisma)).toBe(1)
    expect(await backfillSignatureClusters(prisma)).toBe(0)
  })
})
