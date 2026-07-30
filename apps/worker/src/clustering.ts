import { randomUUID } from 'node:crypto'

import { errorTokens, nearestCluster } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'

import { resolveClusterThreshold } from './rca'

interface Anchor {
  clusterId: string
  tokens: Set<string>
}

export const backfillSignatureClusters = async (
  prisma: PrismaClient,
  options: { threshold?: number } = {},
): Promise<number> => {
  const threshold = options.threshold ?? resolveClusterThreshold()
  const projects = await prisma.errorSignature.findMany({
    where: { clusterId: null },
    distinct: ['projectId'],
    select: { projectId: true },
  })

  let assigned = 0
  for (const { projectId } of projects) {
    const rows = await prisma.errorSignature.findMany({
      where: { projectId },
      orderBy: { firstSeenAt: 'asc' },
      select: { id: true, clusterId: true, sampleMessage: true, stackTemplate: true },
    })

    const anchors: Anchor[] = rows
      .filter((row) => row.clusterId)
      .map((row) => ({
        clusterId: row.clusterId!,
        tokens: errorTokens(row.sampleMessage, row.stackTemplate),
      }))

    for (const row of rows) {
      if (row.clusterId) continue
      const tokens = errorTokens(row.sampleMessage, row.stackTemplate)
      const match = nearestCluster(tokens, anchors, threshold)
      const clusterId = match?.candidate.clusterId ?? randomUUID()
      await prisma.errorSignature.update({ where: { id: row.id }, data: { clusterId } })
      anchors.push({ clusterId, tokens })
      assigned += 1
    }
  }

  return assigned
}
