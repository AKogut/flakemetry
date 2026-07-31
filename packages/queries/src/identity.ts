import type { Prisma, PrismaClient } from '@flakemetry/db'

import { computeIdentityScore, type ScoringOptions } from './scoring'

export interface SplitIdentityParams {
  orgId: string
  projectId: string
  sourceIdentityId: string
  fingerprint: string
  userId?: string | null
  scoring?: ScoringOptions
}

export type SplitIdentityOutcome =
  | { status: 'split'; targetIdentityId: string; movedExecutions: number }
  | { status: 'rejected'; reason: string }

const dayStart = (date: Date): Date => {
  const day = new Date(date)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

const rebuildDailyStats = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  projectId: string,
  identityId: string,
): Promise<void> => {
  await tx.dailyTestStats.deleteMany({ where: { testIdentityId: identityId } })

  const executions = await tx.testExecution.findMany({
    where: { projectId, testIdentityId: identityId },
    select: { status: true, durationMs: true, startedAt: true },
  })
  if (executions.length === 0) return

  const byDay = new Map<
    number,
    { total: number; passed: number; failed: number; flaky: number; skipped: number; ms: number }
  >()
  for (const execution of executions) {
    const key = dayStart(execution.startedAt).getTime()
    const bucket = byDay.get(key) ?? {
      total: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      ms: 0,
    }
    bucket.total += 1
    bucket.ms += execution.durationMs
    if (execution.status === 'pass') bucket.passed += 1
    else if (execution.status === 'fail') bucket.failed += 1
    else if (execution.status === 'flaky') bucket.flaky += 1
    else if (execution.status === 'skip') bucket.skipped += 1
    byDay.set(key, bucket)
  }

  await tx.dailyTestStats.createMany({
    data: [...byDay.entries()].map(([day, bucket]) => ({
      orgId,
      projectId,
      testIdentityId: identityId,
      day: new Date(day),
      total: bucket.total,
      passed: bucket.passed,
      failed: bucket.failed,
      flaky: bucket.flaky,
      skipped: bucket.skipped,
      avgDurationMs: Math.round(bucket.ms / bucket.total),
    })),
  })
}

export const splitIdentity = async (
  prisma: PrismaClient,
  params: SplitIdentityParams,
): Promise<SplitIdentityOutcome> => {
  const { orgId, projectId, sourceIdentityId, fingerprint } = params

  const source = await prisma.testIdentity.findFirst({
    where: { id: sourceIdentityId, projectId },
    select: {
      id: true,
      fingerprint: true,
      filePath: true,
      suite: true,
      title: true,
      paramsHash: true,
      aliases: true,
      lastSeenAt: true,
    },
  })
  if (!source) return { status: 'rejected', reason: 'test identity not found' }
  if (!source.aliases.includes(fingerprint))
    return { status: 'rejected', reason: 'that fingerprint is not stitched into this test' }

  const stitches = await prisma.identityStitch.findMany({
    where: { testIdentityId: sourceIdentityId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fromFingerprint: true,
      fromFilePath: true,
      fromTitle: true,
      toFilePath: true,
      toTitle: true,
      runStartedAt: true,
      createdAt: true,
    },
  })

  const stitch = stitches.find((entry) => entry.fromFingerprint === fingerprint)
  if (!stitch) return { status: 'rejected', reason: 'no recorded stitch for that fingerprint' }
  if (stitches[0]?.id !== stitch.id)
    return {
      status: 'rejected',
      reason: 'only the most recent stitch can be split; split newer stitches first',
    }

  const existingTarget = await prisma.testIdentity.findFirst({
    where: { projectId, fingerprint },
    select: { id: true },
  })
  if (existingTarget)
    return { status: 'rejected', reason: 'an identity with that fingerprint already exists' }

  const boundary = stitch.runStartedAt ?? stitch.createdAt

  const result = await prisma.$transaction(async (tx) => {
    const target = await tx.testIdentity.create({
      data: {
        orgId,
        projectId,
        fingerprint,
        filePath: stitch.toFilePath,
        suite: source.suite,
        title: stitch.toTitle,
        paramsHash: source.paramsHash,
        firstSeenAt: boundary,
        lastSeenAt: source.lastSeenAt,
      },
      select: { id: true },
    })

    const moved = await tx.testExecution.updateMany({
      where: { projectId, testIdentityId: sourceIdentityId, startedAt: { gte: boundary } },
      data: { testIdentityId: target.id },
    })

    await tx.testHealthEvent.updateMany({
      where: { projectId, testIdentityId: sourceIdentityId, createdAt: { gte: boundary } },
      data: { testIdentityId: target.id },
    })

    await tx.testIdentity.update({
      where: { id: sourceIdentityId },
      data: {
        aliases: source.aliases.filter((alias) => alias !== fingerprint),
        filePath: stitch.fromFilePath ?? source.filePath,
        title: stitch.fromTitle ?? source.title,
      },
    })

    await tx.identityStitch.delete({ where: { id: stitch.id } })

    await rebuildDailyStats(tx, orgId, projectId, sourceIdentityId)
    await rebuildDailyStats(tx, orgId, projectId, target.id)

    await tx.identityChange.create({
      data: {
        orgId,
        projectId,
        userId: params.userId ?? null,
        action: 'split',
        sourceIdentityId,
        targetIdentityId: target.id,
        fingerprint,
        detail: `${stitch.fromTitle ?? source.title} → ${stitch.toTitle}`,
      },
    })

    return { targetIdentityId: target.id, movedExecutions: moved.count }
  })

  const scoring = params.scoring ?? { now: new Date() }
  for (const identityId of [sourceIdentityId, result.targetIdentityId]) {
    const scored = await computeIdentityScore(prisma, orgId, projectId, identityId, scoring)
    await prisma.flakyScore.upsert({
      where: { testIdentityId: identityId },
      create: { testIdentityId: identityId, ...scored.data },
      update: scored.data,
    })
  }

  return { status: 'split', ...result }
}

export interface IdentityChangeEntry {
  action: string
  fingerprint: string
  detail: string | null
  createdAt: Date
  actor: string | null
}

export const listIdentityChanges = async (
  prisma: PrismaClient,
  projectId: string,
  limit = 20,
): Promise<IdentityChangeEntry[]> => {
  const rows = await prisma.identityChange.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      action: true,
      fingerprint: true,
      detail: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  })
  return rows.map((row) => ({
    action: row.action,
    fingerprint: row.fingerprint,
    detail: row.detail,
    createdAt: row.createdAt,
    actor: row.user?.name ?? row.user?.email ?? null,
  }))
}
