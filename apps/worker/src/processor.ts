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

export interface ProcessContext {
  orgId: string
  projectId: string
  now: Date
  threshold?: number
  minSamples?: number
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
          attributes: (execution.attributes ?? null) as Prisma.InputJsonValue,
          startedAt: execution.startedAt,
        },
        select: { id: true },
      })
      createdIds.push(row.id)
    }

    return run.id
  })

  for (const identityId of affected) {
    await scoreIdentity(prisma, identityId, ctx)
  }

  return {
    runId,
    executions: batch.executions.length,
    newIdentities,
    movedIdentities,
    scoredIdentities: affected.size,
  }
}

const scoreIdentity = async (
  prisma: PrismaClient,
  identityId: string,
  ctx: ProcessContext,
): Promise<void> => {
  const executions = await prisma.testExecution.findMany({
    where: { testIdentityId: identityId },
    select: { status: true, attempt: true, startedAt: true, run: { select: { commitSha: true } } },
    orderBy: { startedAt: 'asc' },
  })

  const history: ExecutionPoint[] = executions.map((execution) => ({
    status: execution.status,
    attempt: execution.attempt,
    startedAt: execution.startedAt,
    commitSha: execution.run.commitSha,
  }))

  const result = computeFlakyScore(history, {
    now: ctx.now,
    threshold: ctx.threshold,
    minSamples: ctx.minSamples,
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
}
