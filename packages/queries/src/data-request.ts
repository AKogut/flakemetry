import type { PrismaClient } from '@flakemetry/db'

import { type ErasureTarget, haltIngestion } from './erasure'

export type DataRequestKind = 'export' | 'erasure'
export type DataRequestStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface DataRequestActor {
  actor: string
  actorUserId?: string | null
}

export interface DataRequestRow {
  id: string
  kind: DataRequestKind
  status: DataRequestStatus
  subject: string
  actor: string
  rowCount: number | null
  artifactCount: number | null
  residue: unknown
  error: string | null
  createdAt: Date
  completedAt: Date | null
}

const SELECT = {
  id: true,
  kind: true,
  status: true,
  subject: true,
  actor: true,
  rowCount: true,
  artifactCount: true,
  residue: true,
  error: true,
  createdAt: true,
  completedAt: true,
} as const

export interface ErasureRequestInput extends DataRequestActor {
  target: ErasureTarget
  subject: string
}

/**
 * Revoking the tokens is part of making the request, not part of running it. The sweep may
 * be a minute away and CI does not pause for a deletion request; a project that keeps
 * ingesting while it is being erased would be erased and then partly rebuilt.
 */
export const requestErasure = async (
  prisma: PrismaClient,
  input: ErasureRequestInput,
): Promise<{ id: string; tokensRevoked: number }> => {
  const tokensRevoked = await haltIngestion(prisma, input.target)

  const created = await prisma.dataRequest.create({
    data: {
      orgId: input.target.orgId,
      projectId: input.target.kind === 'project' ? input.target.id : null,
      kind: 'erasure',
      status: 'pending',
      subject: input.subject,
      actor: input.actor,
      actorUserId: input.actorUserId ?? null,
      artifactPrefix: input.target.artifactPrefix,
    },
    select: { id: true },
  })

  return { id: created.id, tokensRevoked }
}

export interface ExportRequestInput extends DataRequestActor {
  orgId: string
  projectId: string
  subject: string
  artifactPrefix: string
}

export const startExportRecord = async (
  prisma: PrismaClient,
  input: ExportRequestInput,
): Promise<string> => {
  const created = await prisma.dataRequest.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId,
      kind: 'export',
      status: 'running',
      subject: input.subject,
      actor: input.actor,
      actorUserId: input.actorUserId ?? null,
      artifactPrefix: input.artifactPrefix,
      startedAt: new Date(),
    },
    select: { id: true },
  })
  return created.id
}

export const completeRequest = async (
  prisma: PrismaClient,
  id: string,
  result: {
    rowCount?: number
    artifactCount?: number
    residue?: Record<string, number>
    verified?: boolean
  },
): Promise<void> => {
  const failed = result.verified === false
  await prisma.dataRequest.update({
    where: { id },
    data: {
      status: failed ? 'failed' : 'completed',
      rowCount: result.rowCount ?? null,
      artifactCount: result.artifactCount ?? null,
      residue:
        result.residue && Object.keys(result.residue).length > 0 ? result.residue : undefined,
      error: failed ? 'data remained after the erasure ran' : null,
      completedAt: new Date(),
    },
  })
}

export const failRequest = async (
  prisma: PrismaClient,
  id: string,
  error: string,
): Promise<void> => {
  await prisma.dataRequest.update({
    where: { id },
    data: { status: 'failed', error: error.slice(0, 500), completedAt: new Date() },
  })
}

export const STALE_RUNNING_MS = 15 * 60 * 1000

export interface ClaimedErasure {
  id: string
  target: ErasureTarget
  subject: string
}

/**
 * A request left `running` by a worker that died is picked up again once it goes stale.
 * Erasure is idempotent — artifacts first, `deleteMany` throughout — so retrying is safe,
 * and a deletion request that quietly stops halfway is not.
 */
export const claimErasures = async (
  prisma: PrismaClient,
  limit = 5,
  now: Date = new Date(),
): Promise<ClaimedErasure[]> => {
  const candidates = await prisma.dataRequest.findMany({
    where: {
      kind: 'erasure',
      OR: [
        { status: 'pending' },
        { status: 'running', startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, orgId: true, projectId: true, subject: true, artifactPrefix: true },
  })

  const claimed: ClaimedErasure[] = []
  for (const candidate of candidates) {
    const { count } = await prisma.dataRequest.updateMany({
      where: { id: candidate.id, status: { in: ['pending', 'running'] } },
      data: { status: 'running', startedAt: now },
    })
    if (count === 0) continue

    claimed.push({
      id: candidate.id,
      subject: candidate.subject,
      target: {
        kind: candidate.projectId ? 'project' : 'org',
        id: candidate.projectId ?? candidate.orgId,
        orgId: candidate.orgId,
        artifactPrefix: candidate.artifactPrefix,
      },
    })
  }
  return claimed
}

export const listDataRequests = async (
  prisma: PrismaClient,
  scope: { projectId?: string; orgId?: string },
  limit = 20,
): Promise<DataRequestRow[]> => {
  const rows = await prisma.dataRequest.findMany({
    where: scope.projectId ? { projectId: scope.projectId } : { orgId: scope.orgId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: SELECT,
  })
  return rows as DataRequestRow[]
}
