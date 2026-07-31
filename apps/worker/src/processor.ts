import type { LlmProvider } from '@flakemetry/ai'
import type { HealthEventKind, IngestRunBatch } from '@flakemetry/contracts'
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
import { type FailureRecord, processFailures } from './rca'
import { detectSuiteDurationRegressions, detectSuiteRegressions } from './regressions'
import { updateRollups } from './rollups'

export interface ProcessContext {
  orgId: string
  projectId: string
  now: Date
  threshold?: number
  minSamples?: number
  provider?: LlmProvider | null
  aiEnabled?: boolean
  aiDailyTokenBudget?: number
  quarantineEnabled?: boolean
  quarantineCooldownRuns?: number
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
  const failures: FailureRecord[] = []
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
        shardIndex: batch.resource.shardIndex ?? null,
        shardTotal: batch.resource.shardTotal ?? null,
        trigger: batch.resource.trigger,
        status: batch.run.status,
        startedAt,
        finishedAt,
        durationMs: runDurationMs(startedAt, finishedAt),
        otelTraceId: batch.run.traceId ?? null,
      },
      update: {
        status: batch.run.status,
        finishedAt,
        durationMs: runDurationMs(startedAt, finishedAt),
        otelTraceId: batch.run.traceId ?? null,
      },
      select: { id: true },
    })

    const prepared = batch.executions.map((execution) => {
      const paramsHash = hashParams(execution.params ?? null)
      const fingerprint = computeFingerprint({
        filePath: execution.filePath,
        suite: execution.suite,
        title: execution.title,
        paramsHash,
      })
      return { execution, paramsHash, fingerprint }
    })

    const fingerprints = [...new Set(prepared.map((item) => item.fingerprint))]
    const suites = [...new Set(prepared.map((item) => item.execution.suite))]
    const titles = [...new Set(prepared.map((item) => item.execution.title))]
    const filePaths = [...new Set(prepared.map((item) => item.execution.filePath))]

    const identities =
      prepared.length === 0
        ? []
        : await tx.testIdentity.findMany({
            where: {
              projectId: ctx.projectId,
              OR: [
                { fingerprint: { in: fingerprints } },
                { aliases: { hasSome: fingerprints } },
                { suite: { in: suites }, title: { in: titles } },
                { filePath: { in: filePaths } },
              ],
            },
            select: {
              id: true,
              fingerprint: true,
              suite: true,
              title: true,
              paramsHash: true,
              aliases: true,
              filePath: true,
            },
          })
    const existing: ExistingIdentity[] = identities.map((identity) => ({ ...identity }))

    const createdIds: string[] = []
    for (const { execution, paramsHash, fingerprint } of prepared) {
      const resolution = resolveIdentity(
        {
          fingerprint,
          suite: execution.suite,
          title: execution.title,
          paramsHash,
          filePath: execution.filePath,
        },
        existing,
      )

      let identityId: string
      if (resolution.kind === 'exact') {
        identityId = resolution.identityId
        await tx.testIdentity.update({
          where: { id: identityId },
          data: { lastSeenAt: startedAt, filePath: execution.filePath },
        })
      } else if (resolution.kind === 'moved' || resolution.kind === 'renamed') {
        identityId = resolution.identityId
        movedIdentities += 1
        await tx.testIdentity.update({
          where: { id: identityId },
          data: {
            aliases: { push: resolution.addAlias },
            filePath: execution.filePath,
            ...(resolution.kind === 'renamed' ? { title: execution.title } : {}),
            lastSeenAt: startedAt,
          },
        })
        const entry = existing.find((item) => item.id === identityId)
        if (entry) {
          entry.aliases = [...entry.aliases, resolution.addAlias]
          if (resolution.kind === 'renamed') entry.title = execution.title
        }
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
          filePath: execution.filePath,
        })
        createdEvents.push({ testIdentityId: identityId, projectId: ctx.projectId, fingerprint })
      }

      affected.add(identityId)
      const retryOf =
        execution.retryOfIndex != null ? (createdIds[execution.retryOfIndex] ?? null) : null
      const ordinal = createdIds.length

      const fields = {
        testIdentityId: identityId,
        attempt: execution.attempt,
        retryOf,
        status: execution.status,
        durationMs: execution.durationMs,
        errorMessage: execution.error?.message ?? null,
        otelTraceId: execution.traceId ?? batch.run.traceId ?? null,
        otelSpanId: execution.spanId ?? null,
        artifactsRef: (execution.artifacts ?? null) as Prisma.InputJsonValue,
        attributes: (execution.attributes ?? null) as Prisma.InputJsonValue,
        spans: (execution.spans ?? null) as Prisma.InputJsonValue,
        startedAt: execution.startedAt,
      }
      const row = await tx.testExecution.upsert({
        where: { runId_ordinal: { runId: run.id, ordinal } },
        create: { ...tenant, runId: run.id, ordinal, ...fields },
        update: fields,
        select: { id: true },
      })
      createdIds.push(row.id)

      if (execution.error) {
        failures.push({
          executionId: row.id,
          filePath: execution.filePath,
          suite: execution.suite,
          title: execution.title,
          errorType: execution.error.type ?? null,
          errorMessage: execution.error.message,
          errorStack: execution.error.stack ?? null,
        })
      }
    }

    await tx.testExecution.deleteMany({
      where: {
        runId: run.id,
        OR: [{ ordinal: null }, { ordinal: { gte: batch.executions.length } }],
      },
    })

    return run.id
  })

  for (const event of createdEvents) ctx.events?.emit('identity.created', event)
  for (const event of movedEvents) ctx.events?.emit('identity.moved', event)

  for (const identityId of affected) {
    await scoreIdentity(prisma, identityId, ctx)
  }

  await updateRollups(
    prisma,
    { orgId: ctx.orgId, projectId: ctx.projectId },
    [startedAt, ...batch.executions.map((execution) => execution.startedAt)],
    [...affected],
    ctx.now,
  )

  if (ctx.events) {
    const day = new Date(startedAt)
    day.setUTCHours(0, 0, 0, 0)
    const regressions = await detectSuiteRegressions(prisma, ctx.projectId, day)
    for (const regression of regressions) {
      ctx.events.emit('suite.regressed', { projectId: ctx.projectId, ...regression })
    }
    const slowdowns = await detectSuiteDurationRegressions(prisma, ctx.projectId, day)
    for (const slowdown of slowdowns) {
      ctx.events.emit('suite.slowed', { projectId: ctx.projectId, ...slowdown })
    }
  }

  await processFailures(
    prisma,
    {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      now: ctx.now,
      provider: ctx.provider,
      aiEnabled: ctx.aiEnabled,
      dailyTokenBudget: ctx.aiDailyTokenBudget,
      events: ctx.events,
    },
    failures,
  )

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

type QuarantineTransition = 'quarantined' | 'unquarantined' | null

const QUARANTINE_REASON = 'auto: flaky score above threshold'

const enforceQuarantine = async (
  tx: Prisma.TransactionClient,
  identityId: string,
  identity: { quarantined: boolean },
  isCandidate: boolean,
  recent: readonly { status: string }[],
  cooldownRuns: number,
): Promise<QuarantineTransition> => {
  if (isCandidate && !identity.quarantined) {
    await tx.testIdentity.update({
      where: { id: identityId },
      data: { quarantined: true, quarantineReason: QUARANTINE_REASON },
    })
    return 'quarantined'
  }

  if (!isCandidate && identity.quarantined) {
    const window = recent.slice(-Math.max(cooldownRuns, 1))
    const stable =
      cooldownRuns <= 0 ||
      (window.length >= cooldownRuns &&
        window.every((execution) => execution.status === 'pass' || execution.status === 'skip'))
    if (stable) {
      await tx.testIdentity.update({
        where: { id: identityId },
        data: { quarantined: false, quarantineReason: null },
      })
      return 'unquarantined'
    }
  }

  return null
}

const SCORING_WINDOW = 500

const scoreIdentity = async (
  prisma: PrismaClient,
  identityId: string,
  ctx: ProcessContext,
): Promise<void> => {
  const recent = await prisma.testExecution.findMany({
    where: { projectId: ctx.projectId, testIdentityId: identityId },
    select: {
      status: true,
      attempt: true,
      startedAt: true,
      runId: true,
      run: { select: { commitSha: true, ciRunId: true } },
    },
    orderBy: { startedAt: 'desc' },
    take: SCORING_WINDOW,
  })
  const executions = recent.reverse()

  const [identity, previousScore] = await Promise.all([
    prisma.testIdentity.findUnique({
      where: { id: identityId },
      select: { title: true, suite: true, filePath: true, quarantined: true },
    }),
    prisma.flakyScore.findUnique({
      where: { testIdentityId: identityId },
      select: { quarantineCandidate: true },
    }),
  ])

  const runIds = [...new Set(executions.map((execution) => execution.runId))]
  const ciRunIds = [
    ...new Set(
      executions
        .map((execution) => execution.run.ciRunId)
        .filter((ciRunId): ciRunId is string => Boolean(ciRunId)),
    ),
  ]

  const groupRuns = await prisma.run.findMany({
    where: {
      projectId: ctx.projectId,
      OR: [{ id: { in: runIds } }, ...(ciRunIds.length > 0 ? [{ ciRunId: { in: ciRunIds } }] : [])],
    },
    select: { id: true, ciRunId: true },
  })
  const keyByRunId = new Map(groupRuns.map((run) => [run.id, run.ciRunId ?? run.id]))

  const failingTestsByKey = new Map<string, Set<string>>()
  if (groupRuns.length > 0) {
    const grouped = await prisma.testExecution.groupBy({
      by: ['runId', 'testIdentityId'],
      where: {
        projectId: ctx.projectId,
        runId: { in: groupRuns.map((run) => run.id) },
        status: 'fail',
      },
      _count: { _all: true },
    })
    for (const row of grouped) {
      const key = keyByRunId.get(row.runId) ?? row.runId
      const set = failingTestsByKey.get(key) ?? new Set<string>()
      set.add(row.testIdentityId)
      failingTestsByKey.set(key, set)
    }
  }

  const history: ExecutionPoint[] = executions.map((execution) => ({
    status: execution.status,
    attempt: execution.attempt,
    startedAt: execution.startedAt,
    commitSha: execution.run.commitSha,
    runFailureCount:
      failingTestsByKey.get(keyByRunId.get(execution.runId) ?? execution.runId)?.size ?? 0,
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

  const becameFlaky = result.quarantineCandidate && !previousScore?.quarantineCandidate
  const stabilized = !result.quarantineCandidate && previousScore?.quarantineCandidate === true

  const transition = await prisma.$transaction(async (tx) => {
    await tx.flakyScore.upsert({
      where: { testIdentityId: identityId },
      create: { testIdentityId: identityId, ...data },
      update: data,
    })

    const healthEvents: HealthEventKind[] = []
    if (becameFlaky) healthEvents.push('flaked')
    if (stabilized) healthEvents.push('stabilized')

    let quarantineTransition: QuarantineTransition = null
    if (ctx.quarantineEnabled && identity) {
      quarantineTransition = await enforceQuarantine(
        tx,
        identityId,
        identity,
        result.quarantineCandidate,
        executions,
        ctx.quarantineCooldownRuns ?? 0,
      )
      if (quarantineTransition) healthEvents.push(quarantineTransition)
    }

    if (healthEvents.length > 0) {
      await tx.testHealthEvent.createMany({
        data: healthEvents.map((kind) => ({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          testIdentityId: identityId,
          kind,
          score: result.score,
          createdAt: ctx.now,
        })),
      })
    }

    return quarantineTransition
  })

  if (identity && becameFlaky) {
    ctx.events?.emit('flaky.detected', {
      testIdentityId: identityId,
      projectId: ctx.projectId,
      title: identity.title,
      suite: identity.suite,
      filePath: identity.filePath,
      score: result.score,
    })
  }

  if (identity && transition) {
    ctx.events?.emit('quarantine.changed', {
      testIdentityId: identityId,
      projectId: ctx.projectId,
      title: identity.title,
      suite: identity.suite,
      quarantined: transition === 'quarantined',
      reason: transition === 'quarantined' ? QUARANTINE_REASON : null,
    })
  }

  ctx.events?.emit('score.updated', {
    testIdentityId: identityId,
    projectId: ctx.projectId,
    score: result.score,
    quarantineCandidate: result.quarantineCandidate,
  })
}
