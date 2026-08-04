import { randomUUID } from 'node:crypto'

import { errorTokens } from '@flakemetry/core'
import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { backfillSignatureClusters, findClusterCandidates } from '../clustering'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()
const NOW = new Date('2026-07-27T12:00:00Z')

const seed = async () => {
  // Two tenants inside one test land in the same millisecond, so a clock-derived slug
  // collides on the unique index.
  const suffix = randomUUID()
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${suffix}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${suffix}` },
  })
  return { orgId: org.id, projectId: project.id }
}

const signature = async (
  tenant: { orgId: string; projectId: string },
  hash: string,
  message: string,
  options: { seenAt?: Date; withTokens?: boolean } = {},
) => {
  const seenAt = options.seenAt ?? NOW
  return prisma.errorSignature.create({
    data: {
      ...tenant,
      normalizedHash: hash,
      sampleMessage: message,
      stackTemplate: '',
      tokens: options.withTokens === false ? [] : [...errorTokens(message)],
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    },
    select: { id: true },
  })
}

describe.skipIf(!hasDb)('cluster candidate lookup', () => {
  beforeEach(async () => {
    await prisma.errorSignature.deleteMany()
    await prisma.errorCluster.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('ranks by token overlap, so the best match wins however old it is', async () => {
    const tenant = await seed()
    const target = 'Element #login is not visible in the viewport'

    // The real cluster mate is the oldest row, and the decoy is the newest. The decoy
    // has to *overlap* — a row sharing no tokens is dropped by the index filter before
    // ordering matters, so a non-overlapping decoy would prove nothing about ranking.
    const mate = await signature(tenant, 'old', 'Element #logout is not visible in the viewport', {
      seenAt: new Date('2026-01-01T00:00:00Z'),
    })
    await signature(tenant, 'decoy', 'Element missing', {
      seenAt: new Date('2026-07-01T00:00:00Z'),
    })

    const candidates = await findClusterCandidates(
      prisma,
      tenant.projectId,
      [...errorTokens(target)],
      { limit: 1 },
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.id).toBe(mate.id)
  })

  it('never offers a signature as its own cluster candidate', async () => {
    const tenant = await seed()
    const message = 'Timeout waiting for selector to appear'
    const only = await signature(tenant, 'solo', message)

    const candidates = await findClusterCandidates(
      prisma,
      tenant.projectId,
      [...errorTokens(message)],
      { excludeSignatureId: only.id },
    )

    expect(candidates).toEqual([])
  })

  it('does not reach across projects', async () => {
    const mine = await seed()
    const theirs = await seed()
    const message = 'Element #login is not visible in the viewport'
    await signature(theirs, 'other', message)

    expect(await findClusterCandidates(prisma, mine.projectId, [...errorTokens(message)])).toEqual(
      [],
    )
  })
})

describe.skipIf(!hasDb)('backfillSignatureClusters', () => {
  beforeEach(async () => {
    await prisma.errorSignature.deleteMany()
    await prisma.errorCluster.deleteMany()
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

    const assigned = await backfillSignatureClusters(prisma, { now: NOW })
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

  it('gives every cluster a row of its own, with a label and honest counters', async () => {
    const tenant = await seed()
    await signature(tenant, 'h1', 'Element #login is not visible in the viewport')
    await signature(tenant, 'h2', 'Element #logout is not visible in the viewport')
    await signature(tenant, 'h3', 'Request failed with status code 500 Internal Server Error')

    await backfillSignatureClusters(prisma, { now: NOW })

    const clusters = await prisma.errorCluster.findMany({
      where: { projectId: tenant.projectId },
      orderBy: { signatureCount: 'desc' },
      select: { label: true, signatureCount: true },
    })

    // A cluster id used to be a bare uuid pointing at nothing, so there was nowhere to
    // hang a name, a count, or a known-issue reference.
    expect(clusters).toHaveLength(2)
    expect(clusters[0]?.signatureCount).toBe(2)
    expect(clusters[1]?.signatureCount).toBe(1)
    expect(clusters[0]?.label).toContain('not visible')
  })

  it('counts a signature once even when an earlier row pulled it into the cluster', async () => {
    const tenant = await seed()
    // The oldest row's nearest match is the *newest* row, so assigning a cluster to the
    // first one adopts the last one. The loop's snapshot still calls that row
    // unclustered, and processing it again would mint a duplicate cluster and inflate
    // the count.
    await signature(tenant, 'first', 'Element #login is not visible in the viewport', {
      seenAt: new Date('2026-01-01T00:00:00Z'),
    })
    await signature(tenant, 'middle', 'Database connection pool exhausted', {
      seenAt: new Date('2026-02-01T00:00:00Z'),
    })
    await signature(tenant, 'last', 'Element #logout is not visible in the viewport', {
      seenAt: new Date('2026-03-01T00:00:00Z'),
    })

    expect(await backfillSignatureClusters(prisma, { now: NOW })).toBe(3)

    const clusters = await prisma.errorCluster.findMany({
      where: { projectId: tenant.projectId },
      orderBy: { signatureCount: 'desc' },
      select: { signatureCount: true },
    })
    expect(clusters.map((cluster) => cluster.signatureCount)).toEqual([2, 1])
  })

  it('settles tokens seeded by the migration onto the real tokenizer', async () => {
    const tenant = await seed()
    const message = 'Element #login is not visible in the viewport'
    const row = await signature(tenant, 'h1', message, { withTokens: false })

    await backfillSignatureClusters(prisma, { now: NOW })

    const stored = await prisma.errorSignature.findUniqueOrThrow({
      where: { id: row.id },
      select: { tokens: true },
    })
    expect([...stored.tokens].sort()).toEqual([...errorTokens(message)].sort())
  })

  it('is idempotent — a second pass assigns nothing and creates no extra clusters', async () => {
    const tenant = await seed()
    await signature(tenant, 'h1', 'Timeout waiting for selector to appear')

    expect(await backfillSignatureClusters(prisma, { now: NOW })).toBe(1)
    const after = await prisma.errorCluster.count({ where: { projectId: tenant.projectId } })

    expect(await backfillSignatureClusters(prisma, { now: NOW })).toBe(0)
    expect(await prisma.errorCluster.count({ where: { projectId: tenant.projectId } })).toBe(after)
  })
})
