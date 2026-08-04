import { DEFAULT_CLUSTER_THRESHOLD, errorTokens, nearestCluster } from '@flakemetry/core'
import type { Prisma, PrismaClient } from '@flakemetry/db'

export const CANDIDATE_LIMIT = 200

export type ClusterClient = PrismaClient | Prisma.TransactionClient

export const resolveClusterThreshold = (): number => {
  const raw = Number(process.env.FLAKEMETRY_CLUSTER_THRESHOLD)
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CLUSTER_THRESHOLD
}

interface CandidateRow {
  id: string
  clusterId: string | null
  tokens: string[]
}

/**
 * Narrows on token overlap through the GIN index rather than reading the most recent
 * N signatures. The recency window silently stopped matching once a project grew past
 * it: a failure whose cluster mates had aged out of the window looked brand new.
 */
export const findClusterCandidates = async (
  prisma: ClusterClient,
  projectId: string,
  tokens: readonly string[],
  options: { limit?: number; excludeSignatureId?: string } = {},
): Promise<CandidateRow[]> => {
  if (tokens.length === 0) return []
  const target = [...tokens]
  const limit = options.limit ?? CANDIDATE_LIMIT
  const exclude = options.excludeSignatureId ?? null
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT id, cluster_id AS "clusterId", tokens
    FROM error_signature
    WHERE project_id = ${projectId}::uuid
      AND tokens && ${target}::text[]
      AND (${exclude}::uuid IS NULL OR id <> ${exclude}::uuid)
    ORDER BY
      cardinality(ARRAY(SELECT unnest(tokens) INTERSECT SELECT unnest(${target}::text[]))) DESC,
      last_seen_at DESC
    LIMIT ${limit}
  `
}

export const clusterLabel = (message: string): string =>
  message.replace(/\s+/g, ' ').trim().slice(0, 200)

export interface ClusterAssignment {
  clusterId: string
  createdCluster: boolean
  adoptedSignatureId: string | null
}

/**
 * Resolves the cluster a signature belongs to, creating one when nothing is close
 * enough. `adoptedSignatureId` reports a pre-clustering signature pulled into a newly
 * created cluster, so the caller can keep the cluster's counters honest.
 */
export const assignCluster = async (
  prisma: ClusterClient,
  ctx: { orgId: string; projectId: string; now: Date },
  candidate: {
    tokens: readonly string[]
    sampleMessage: string
    threshold?: number
    excludeSignatureId?: string
  },
): Promise<ClusterAssignment> => {
  const threshold = candidate.threshold ?? resolveClusterThreshold()
  const rows = await findClusterCandidates(prisma, ctx.projectId, candidate.tokens, {
    excludeSignatureId: candidate.excludeSignatureId,
  })
  const match = nearestCluster(
    new Set(candidate.tokens),
    rows.map((row) => ({ id: row.id, clusterId: row.clusterId, tokens: new Set(row.tokens) })),
    threshold,
  )

  if (match?.candidate.clusterId) {
    return { clusterId: match.candidate.clusterId, createdCluster: false, adoptedSignatureId: null }
  }

  const created = await prisma.errorCluster.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      label: clusterLabel(candidate.sampleMessage),
      firstSeenAt: ctx.now,
      lastSeenAt: ctx.now,
    },
    select: { id: true },
  })

  if (!match) {
    return { clusterId: created.id, createdCluster: true, adoptedSignatureId: null }
  }

  // The nearest signature is close enough to belong here but predates clustering.
  // Pull it in, or the pair never converges on one cluster.
  await prisma.errorSignature.update({
    where: { id: match.candidate.id },
    data: { clusterId: created.id },
  })
  await prisma.errorCluster.update({
    where: { id: created.id },
    data: { signatureCount: { increment: 1 } },
  })

  return { clusterId: created.id, createdCluster: true, adoptedSignatureId: match.candidate.id }
}

export const recordClusterOccurrence = async (
  prisma: ClusterClient,
  clusterId: string,
  now: Date,
  addedSignature: boolean,
): Promise<void> => {
  await prisma.errorCluster.update({
    where: { id: clusterId },
    data: {
      lastSeenAt: now,
      occurrenceCount: { increment: 1 },
      ...(addedSignature ? { signatureCount: { increment: 1 } } : {}),
    },
  })
}

const sameTokens = (stored: readonly string[], computed: readonly string[]): boolean =>
  stored.length === computed.length &&
  new Set(stored).size === new Set([...stored, ...computed]).size

export const backfillSignatureClusters = async (
  prisma: PrismaClient,
  options: { threshold?: number; now?: Date } = {},
): Promise<number> => {
  const threshold = options.threshold ?? resolveClusterThreshold()
  const now = options.now ?? new Date()

  const projects = await prisma.errorSignature.findMany({
    where: { OR: [{ clusterId: null }, { tokens: { isEmpty: true } }] },
    distinct: ['projectId'],
    select: { projectId: true, orgId: true },
  })

  let assigned = 0
  for (const { projectId, orgId } of projects) {
    const rows = await prisma.errorSignature.findMany({
      where: { projectId },
      orderBy: { firstSeenAt: 'asc' },
      select: {
        id: true,
        clusterId: true,
        sampleMessage: true,
        stackTemplate: true,
        tokens: true,
      },
    })

    // Tokens first, for every row: candidate lookup narrows on token overlap, so a row
    // that has not been tokenized yet is invisible and would be missed as a match. The
    // migration seeded tokens with a SQL approximation; this settles them on the real
    // tokenizer.
    const tokensById = new Map<string, string[]>()
    for (const row of rows) {
      const tokens = [...errorTokens(row.sampleMessage, row.stackTemplate)]
      tokensById.set(row.id, tokens)
      if (!sameTokens(row.tokens, tokens)) {
        await prisma.errorSignature.update({ where: { id: row.id }, data: { tokens } })
      }
    }

    // Assigning a cluster can pull a *later* row into it, and this snapshot still
    // reports that row as unclustered. Without tracking it, the second pass over it
    // would mint a duplicate cluster and count the signature twice.
    const adopted = new Set<string>()
    for (const row of rows) {
      if (row.clusterId || adopted.has(row.id)) continue
      const tokens = tokensById.get(row.id) ?? []

      const assignment = await assignCluster(
        prisma,
        { orgId, projectId, now },
        { tokens, sampleMessage: row.sampleMessage, threshold, excludeSignatureId: row.id },
      )
      await prisma.errorSignature.update({
        where: { id: row.id },
        data: { clusterId: assignment.clusterId },
      })
      await prisma.errorCluster.update({
        where: { id: assignment.clusterId },
        data: { signatureCount: { increment: 1 }, lastSeenAt: now },
      })
      assigned += 1

      if (assignment.adoptedSignatureId) {
        adopted.add(assignment.adoptedSignatureId)
        assigned += 1
      }
    }
  }

  return assigned
}
