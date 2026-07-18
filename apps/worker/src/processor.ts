import type { IngestRunBatch } from '@flakemetry/contracts'
import {
  computeFingerprint,
  computeFlakyScore,
  type ExecutionPoint,
  type ExistingIdentity,
  hashParams,
  resolveIdentity,
} from '@flakemetry/core'
import type { Prisma, PrismaClient } from '@flakemetry/db'

import type { EventBus } from './events'

export interface ProcessContext {
  orgId: string
  projectId: string
  now: Date
  threshold?: number
  minSamples?: number
  events?: EventBus
}

export interface ProcessResult {
  runId: string
  executions: number
  newIdentities: number
  movedIdentities: number
  scoredIdentities: number
}

const runDurationMs = (startedAt: Date, finishedAt: Date | null): number | null =>
  finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null

export const processJob = async (
  prisma: PrismaClient,
  batch: IngestRunBatch,
  ctx: ProcessContext,
): Promise<ProcessResult> => {
  const tenant = { orgId: ctx.orgId, projectId: ctx.projectId }
  const startedAt = batch.run.startedAt
  const finishedAt = batch.run.finishedAt ?? null

  const affected = new Set<string>()
  const createdEvents: { testIdentityId: string; projectId: string; fingerprint: string }[] = []
  const movedEvents: { testIdentityId: string; projectId: string; alias: string }[] = []
  let newIdentities = 0
  let movedIdentities = 0

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.run.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId: ctx.projectId,
          idempotencyKey: batch.idempotencyKey,
        },
      },
      create: {
        ...tenant,
        idempotencyKey: batch.idempotencyKey,
        commitSha: batch.resource.commitSha,
        branch: batch.resource.branch,
        prNumber: batch.resource.prNumber ?? null,
        ciProvider: batch.resource.ciProvider,
        ciRunId: batch.resource.ciRunId ?? null,
        trigger: batch.resource.trigger,
        status: batch.run.status,
        startedAt,
        finishedAt,
        durationMs: runDurationMs(startedAt, finishedAt),
      },
      update: {
        status: batch.run.status,
        finishedAt,
        durationMs: runDurationMs(startedAt, finishedAt),
      },
      select: { id: true },
    })

    await tx.testExecution.deleteMany({ where: { runId: run.id } })

    const identities = await tx.testIdentity.findMany({
      where: { projectId: ctx.projectId },
      select: {
        id: true,
        fingerprint: true,
        suite: true,
        title: true,
        paramsHash: true,
        aliases: true,
      },
    })
    const existing: ExistingIdentity[] = identities.map((identity) => ({ ...identity }))

    const createdIds: string[] = []
    for (const execution of batch.executions) {
      const paramsHash = hashParams(execution.params ?? null)
      const fingerprint = computeFingerprint({
        filePath: execution.filePath,
        suite: execution.suite,
        title: execution.title,
        paramsHash,
      })
      const resolution = resolveIdentity(
        { fingerprint, suite: execution.suite, title: execution.title, paramsHash },
        existing,
      )

      let identityId: string
      if (resolution.kind === 'exact') {
        identityId = resolution.identityId
        await tx.testIdentity.update({
          where: { id: identityId },
          data: { lastSeenAt: startedAt, filePath: execution.filePath },
        })
      } else if (resolution.kind === 'moved') {
        identityId = resolution.identityId
        movedIdentities += 1
        await tx.testIdentity.update({
          where: { id: identityId },
          data: {
            aliases: { push: resolution.addAlias },
            filePath: execution.filePath,
            lastSeenAt: startedAt,
          },
        })
        const entry = existing.find((item) => item.id === identityId)
        if (entry) entry.aliases = [...entry.aliases, resolution.addAlias]
        movedEvents.push({
          testIdentityId: identityId,
          projectId: ctx.projectId,
          alias: resolution.addAlias,
        })
      } else {
        newIdentities += 1
        const created = await tx.testIdentity.upsert({
          where: { projectId_fingerprint: { projectId: ctx.projectId, fingerprint } },
          create: {
            ...tenant,
            fingerprint,
            filePath: execution.filePath,
            suite: execution.suite,
            title: execution.title,
            paramsHash,
            firstSeenAt: startedAt,
            lastSeenAt: startedAt,
          },
          update: { lastSeenAt: startedAt },
          select: { id: true },
        })
        identityId = created.id
        existing.push({
          id: identityId,
          fingerprint,
          suite: execution.suite,
          title: execution.title,
          paramsHash,
          aliases: [],
        })
        createdEvents.push({ testIdentityId: identityId, projectId: ctx.projectId, fingerprint })
      }

      affected.add(identityId)
      const retryOf =
        execution.retryOfIndex != null ? (createdIds[execution.retryOfIndex] ?? null) : null

      const row = await tx.testExecution.create({
        data: {
          ...tenant,
          runId: run.id,
          testIdentityId: identityId,
          attempt: execution.attempt,
          retryOf,
          status: execution.status,
          durationMs: execution.durationMs,
          errorMessage: execution.error?.message ?? null,
          otelTraceId: batch.resource.ciRunId ?? null,
          artifactsRef: (execution.artifacts ?? null) as Prisma.InputJsonValue,
          attributes: (execution.attributes ?? null) as Prisma.InputJsonValue,
          startedAt: execution.startedAt,
        },
        select: { id: true },
      })
      createdIds.push(row.id)
    }

    return run.id
  })

  for (const event of createdEvents) ctx.events?.emit('identity.created', event)
  for (const event of movedEvents) ctx.events?.emit('identity.moved', event)

  for (const identityId of affected) {
    await scoreIdentity(prisma, identityId, ctx)
  }

  ctx.events?.emit('run.processed', {
    runId,
    projectId: ctx.projectId,
    executions: batch.executions.length,
    newIdentities,
    movedIdentities,
  })

  return {
    runId,
    executions: batch.executions.length,
    newIdentities,
    movedIdentities,
    scoredIdentities: affected.size,
  }
}

const SCORING_WINDOW = 500

const scoreIdentity = async (
  prisma: PrismaClient,
  identityId: string,
  ctx: ProcessContext,
): Promise<void> => {
  const recent = await prisma.testExecution.findMany({
    where: { testIdentityId: identityId },
    select: {
      status: true,
      attempt: true,
      startedAt: true,
      runId: true,
      run: { select: { commitSha: true } },
    },
    orderBy: { startedAt: 'desc' },
    take: SCORING_WINDOW,
  })
  const executions = recent.reverse()

  const runIds = [...new Set(executions.map((execution) => execution.runId))]
  const failuresByRun = new Map<string, number>()
  if (runIds.length > 0) {
    const grouped = await prisma.testExecution.groupBy({
      by: ['runId'],
      where: { runId: { in: runIds }, status: 'fail' },
      _count: { _all: true },
    })
    for (const row of grouped) failuresByRun.set(row.runId, row._count._all)
  }

  const history: ExecutionPoint[] = executions.map((execution) => ({
    status: execution.status,
    attempt: execution.attempt,
    startedAt: execution.startedAt,
    commitSha: execution.run.commitSha,
    runFailureCount: failuresByRun.get(execution.runId) ?? 0,
  }))

  const result = computeFlakyScore(history, {
    now: ctx.now,
    threshold: ctx.threshold,
    minSamples: ctx.minSamples,
    windowSize: SCORING_WINDOW,
  })

  const lastFlakedAt = executions
    .filter((execution) => execution.status === 'fail' || execution.status === 'flaky')
    .map((execution) => execution.startedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  const data = {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    score: result.score,
    flipRate: result.flipRate,
    passOnRerunRate: result.passOnRerunRate,
    sameShaVariance: result.sameShaVariance,
    entropy: result.entropy,
    failIsolation: result.failIsolation,
    reasonCodes: result.reasonCodes as unknown as Prisma.InputJsonValue,
    quarantineCandidate: result.quarantineCandidate,
    lastFlakedAt: lastFlakedAt ?? null,
    modelVersion: result.modelVersion,
  }

  await prisma.flakyScore.upsert({
    where: { testIdentityId: identityId },
    create: { testIdentityId: identityId, ...data },
    update: data,
  })

  ctx.events?.emit('score.updated', {
    testIdentityId: identityId,
    projectId: ctx.projectId,
    score: result.score,
    quarantineCandidate: result.quarantineCandidate,
  })
}
