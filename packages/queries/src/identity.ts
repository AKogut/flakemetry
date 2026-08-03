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
      level: true,
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
  if (stitch.level === 'manual')
    return {
      status: 'rejected',
      reason: 'a manual merge interleaves both histories and cannot be split apart automatically',
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

export interface MergeIdentitiesParams {
  orgId: string
  projectId: string
  targetIdentityId: string
  sourceIdentityId: string
  userId?: string | null
  scoring?: ScoringOptions
}

export type MergeIdentitiesOutcome =
  { status: 'merged'; movedExecutions: number } | { status: 'rejected'; reason: string }

export interface MergeCandidate {
  id: string
  title: string
  filePath: string
  lastSeenAt: Date
}

export const findMergeCandidates = async (
  prisma: PrismaClient,
  projectId: string,
  identityId: string,
  limit = 25,
): Promise<MergeCandidate[]> => {
  const identity = await prisma.testIdentity.findFirst({
    where: { id: identityId, projectId },
    select: { suite: true, paramsHash: true },
  })
  if (!identity) return []

  return prisma.testIdentity.findMany({
    where: {
      projectId,
      suite: identity.suite,
      paramsHash: identity.paramsHash,
      id: { not: identityId },
    },
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    select: { id: true, title: true, filePath: true, lastSeenAt: true },
  })
}

export const mergeIdentities = async (
  prisma: PrismaClient,
  params: MergeIdentitiesParams,
): Promise<MergeIdentitiesOutcome> => {
  const { orgId, projectId, targetIdentityId, sourceIdentityId } = params

  if (targetIdentityId === sourceIdentityId)
    return { status: 'rejected', reason: 'cannot merge a test into itself' }

  const select = {
    id: true,
    fingerprint: true,
    filePath: true,
    suite: true,
    title: true,
    paramsHash: true,
    params: true,
    aliases: true,
    firstSeenAt: true,
    lastSeenAt: true,
  }
  const [target, source] = await Promise.all([
    prisma.testIdentity.findFirst({ where: { id: targetIdentityId, projectId }, select }),
    prisma.testIdentity.findFirst({ where: { id: sourceIdentityId, projectId }, select }),
  ])
  if (!target || !source) return { status: 'rejected', reason: 'test identity not found' }
  if (target.paramsHash !== source.paramsHash)
    return {
      status: 'rejected',
      reason: 'these are different parameterized cases; merging them would collide their histories',
    }

  const movedExecutions = await prisma.$transaction(async (tx) => {
    const moved = await tx.testExecution.updateMany({
      where: { projectId, testIdentityId: sourceIdentityId },
      data: { testIdentityId: targetIdentityId, mergedFromIdentityId: sourceIdentityId },
    })
    await tx.testHealthEvent.updateMany({
      where: { projectId, testIdentityId: sourceIdentityId },
      data: { testIdentityId: targetIdentityId, mergedFromIdentityId: sourceIdentityId },
    })
    await tx.identityStitch.updateMany({
      where: { testIdentityId: sourceIdentityId },
      data: { testIdentityId: targetIdentityId, mergedFromIdentityId: sourceIdentityId },
    })

    await tx.identityStitch.create({
      data: {
        orgId,
        projectId,
        testIdentityId: targetIdentityId,
        level: 'manual',
        fromFingerprint: source.fingerprint,
        fromFilePath: source.filePath,
        fromTitle: source.title,
        toFilePath: target.filePath,
        toTitle: target.title,
        mergedFromIdentityId: sourceIdentityId,
      },
    })

    await tx.identityMerge.create({
      data: {
        orgId,
        projectId,
        targetIdentityId,
        sourceIdentityId,
        sourceFingerprint: source.fingerprint,
        sourceFilePath: source.filePath,
        sourceSuite: source.suite,
        sourceTitle: source.title,
        sourceParamsHash: source.paramsHash,
        sourceParams: (source.params ?? null) as Prisma.InputJsonValue,
        sourceAliases: source.aliases,
        sourceFirstSeenAt: source.firstSeenAt,
        sourceLastSeenAt: source.lastSeenAt,
      },
    })

    await tx.testIdentity.update({
      where: { id: targetIdentityId },
      data: {
        aliases: [...new Set([...target.aliases, ...source.aliases, source.fingerprint])],
        firstSeenAt:
          source.firstSeenAt < target.firstSeenAt ? source.firstSeenAt : target.firstSeenAt,
        lastSeenAt: source.lastSeenAt > target.lastSeenAt ? source.lastSeenAt : target.lastSeenAt,
      },
    })

    await tx.testIdentity.delete({ where: { id: sourceIdentityId } })

    await rebuildDailyStats(tx, orgId, projectId, targetIdentityId)

    await tx.identityChange.create({
      data: {
        orgId,
        projectId,
        userId: params.userId ?? null,
        action: 'merge',
        sourceIdentityId,
        targetIdentityId,
        fingerprint: source.fingerprint,
        detail: `${source.title} → ${target.title}`,
      },
    })

    return moved.count
  })

  const scoring = params.scoring ?? { now: new Date() }
  const scored = await computeIdentityScore(prisma, orgId, projectId, targetIdentityId, scoring)
  await prisma.flakyScore.upsert({
    where: { testIdentityId: targetIdentityId },
    create: { testIdentityId: targetIdentityId, ...scored.data },
    update: scored.data,
  })

  return { status: 'merged', movedExecutions }
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

export interface UnmergeIdentityParams {
  orgId: string
  projectId: string
  targetIdentityId: string
  userId?: string | null
  scoring?: ScoringOptions
}

export type UnmergeIdentityOutcome =
  | { status: 'unmerged'; restoredIdentityId: string; restoredExecutions: number }
  | { status: 'rejected'; reason: string }

export const unmergeIdentity = async (
  prisma: PrismaClient,
  params: UnmergeIdentityParams,
): Promise<UnmergeIdentityOutcome> => {
  const { orgId, projectId, targetIdentityId } = params

  const target = await prisma.testIdentity.findFirst({
    where: { id: targetIdentityId, projectId },
    select: { id: true, aliases: true },
  })
  if (!target) return { status: 'rejected', reason: 'test identity not found' }

  const merge = await prisma.identityMerge.findFirst({
    where: { projectId, targetIdentityId, undoneAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!merge) return { status: 'rejected', reason: 'this test has no merge left to undo' }

  const collision = await prisma.testIdentity.findFirst({
    where: { projectId, fingerprint: merge.sourceFingerprint },
    select: { id: true },
  })
  if (collision)
    return {
      status: 'rejected',
      reason: 'a test with the merged-in fingerprint exists again; undoing would collide with it',
    }

  const result = await prisma.$transaction(async (tx) => {
    const restored = await tx.testIdentity.create({
      data: {
        orgId,
        projectId,
        fingerprint: merge.sourceFingerprint,
        filePath: merge.sourceFilePath,
        suite: merge.sourceSuite,
        title: merge.sourceTitle,
        paramsHash: merge.sourceParamsHash,
        params: (merge.sourceParams ?? null) as Prisma.InputJsonValue,
        aliases: merge.sourceAliases,
        firstSeenAt: merge.sourceFirstSeenAt,
        lastSeenAt: merge.sourceLastSeenAt,
      },
      select: { id: true },
    })

    const movedBack = await tx.testExecution.updateMany({
      where: {
        projectId,
        testIdentityId: targetIdentityId,
        mergedFromIdentityId: merge.sourceIdentityId,
      },
      data: { testIdentityId: restored.id, mergedFromIdentityId: null },
    })
    await tx.testHealthEvent.updateMany({
      where: {
        projectId,
        testIdentityId: targetIdentityId,
        mergedFromIdentityId: merge.sourceIdentityId,
      },
      data: { testIdentityId: restored.id, mergedFromIdentityId: null },
    })
    await tx.identityStitch.updateMany({
      where: {
        testIdentityId: targetIdentityId,
        mergedFromIdentityId: merge.sourceIdentityId,
        level: { not: 'manual' },
      },
      data: { testIdentityId: restored.id, mergedFromIdentityId: null },
    })

    await tx.identityStitch.deleteMany({
      where: {
        testIdentityId: targetIdentityId,
        level: 'manual',
        mergedFromIdentityId: merge.sourceIdentityId,
      },
    })

    const givenBack = new Set([...merge.sourceAliases, merge.sourceFingerprint])
    await tx.testIdentity.update({
      where: { id: targetIdentityId },
      data: { aliases: target.aliases.filter((alias) => !givenBack.has(alias)) },
    })

    await rebuildDailyStats(tx, orgId, projectId, targetIdentityId)
    await rebuildDailyStats(tx, orgId, projectId, restored.id)

    await tx.identityMerge.update({
      where: { id: merge.id },
      data: { undoneAt: new Date() },
    })

    await tx.identityChange.create({
      data: {
        orgId,
        projectId,
        userId: params.userId ?? null,
        action: 'unmerge',
        sourceIdentityId: targetIdentityId,
        targetIdentityId: restored.id,
        fingerprint: merge.sourceFingerprint,
        detail: `${merge.sourceTitle} restored`,
      },
    })

    return { restoredIdentityId: restored.id, restoredExecutions: movedBack.count }
  })

  const scoring = params.scoring ?? { now: new Date() }
  for (const identityId of [targetIdentityId, result.restoredIdentityId]) {
    const scored = await computeIdentityScore(prisma, orgId, projectId, identityId, scoring)
    await prisma.flakyScore.upsert({
      where: { testIdentityId: identityId },
      create: { testIdentityId: identityId, ...scored.data },
      update: scored.data,
    })
  }

  return { status: 'unmerged', ...result }
}
