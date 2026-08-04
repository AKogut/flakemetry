import { randomUUID } from 'node:crypto'

import type { LlmProvider } from '@flakemetry/ai'
import type { HealthEventKind, IngestRunBatch } from '@flakemetry/contracts'
import {
  collectPresentTitleKeys,
  computeFingerprint,
  type ExistingIdentity,
  hashParams,
  resolveIdentity,
} from '@flakemetry/core'
import type { Prisma, PrismaClient } from '@flakemetry/db'
import { computeIdentityScore } from '@flakemetry/queries'

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

const PENDING_IDENTITY = 'pending:'

/**
 * Prisma defaults an interactive transaction to five seconds, which a full suite exceeded
 * before the writes below were batched. The batching is the fix; this is headroom for a
 * loaded database, not a licence to go back to a statement per test.
 */
const TRANSACTION_LIMITS = { timeout: 120_000, maxWait: 15_000 }

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

    const presentTitleKeys = collectPresentTitleKeys(
      prepared.map(({ execution, paramsHash }) => ({
        filePath: execution.filePath,
        suite: execution.suite,
        paramsHash,
        title: execution.title,
      })),
    )

    const assignments: string[] = []
    const refreshed: string[] = []
    const rewritten: { identityId: string; data: Prisma.TestIdentityUpdateInput }[] = []
    const stitches: Prisma.IdentityStitchCreateManyInput[] = []
    const additions = new Map<string, Prisma.TestIdentityCreateManyInput>()

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
        { presentTitleKeys },
      )

      let identityId: string
      if (resolution.kind === 'exact') {
        identityId = resolution.identityId
        const entry = existing.find((item) => item.id === identityId)
        if (entry?.fingerprint === fingerprint) {
          refreshed.push(identityId)
        } else {
          rewritten.push({
            identityId,
            data: {
              lastSeenAt: startedAt,
              filePath: execution.filePath,
              params: (execution.params ?? null) as Prisma.InputJsonValue,
            },
          })
        }
      } else if (resolution.kind === 'moved' || resolution.kind === 'renamed') {
        identityId = resolution.identityId
        movedIdentities += 1
        const entry = existing.find((item) => item.id === identityId)
        rewritten.push({
          identityId,
          data: {
            aliases: { push: resolution.addAlias },
            filePath: execution.filePath,
            ...(resolution.kind === 'renamed' ? { title: execution.title } : {}),
            lastSeenAt: startedAt,
          },
        })
        stitches.push({
          ...tenant,
          testIdentityId: identityId,
          level: resolution.level,
          fromFingerprint: resolution.addAlias,
          fromFilePath: entry?.filePath ?? null,
          fromTitle: entry?.title ?? null,
          toFilePath: execution.filePath,
          toTitle: execution.title,
          confidence: resolution.kind === 'renamed' ? resolution.confidence : null,
          runStartedAt: startedAt,
        })
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
        identityId = `${PENDING_IDENTITY}${fingerprint}`
        if (!additions.has(fingerprint)) {
          newIdentities += 1
          additions.set(fingerprint, {
            ...tenant,
            fingerprint,
            filePath: execution.filePath,
            suite: execution.suite,
            title: execution.title,
            paramsHash,
            params: (execution.params ?? null) as Prisma.InputJsonValue,
            firstSeenAt: startedAt,
            lastSeenAt: startedAt,
          })
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
      }

      assignments.push(identityId)
    }

    const identityIdByFingerprint = new Map<string, string>()
    if (additions.size > 0) {
      await tx.testIdentity.createMany({ data: [...additions.values()], skipDuplicates: true })
      // Re-read rather than trusting the ids we generated: a concurrent run for the same
      // project may have inserted the same fingerprint first, in which case skipDuplicates
      // dropped ours and the authoritative id is theirs.
      const stored = await tx.testIdentity.findMany({
        where: { projectId: ctx.projectId, fingerprint: { in: [...additions.keys()] } },
        select: { id: true, fingerprint: true },
      })
      for (const row of stored) identityIdByFingerprint.set(row.fingerprint, row.id)
    }

    const settle = (id: string): string => {
      if (!id.startsWith(PENDING_IDENTITY)) return id
      const resolved = identityIdByFingerprint.get(id.slice(PENDING_IDENTITY.length))
      if (!resolved) throw new Error(`identity ${id} was not persisted`)
      return resolved
    }

    if (refreshed.length > 0) {
      // An exact match on the primary fingerprint implies the file path, suite, title and
      // params hash are unchanged, so last-seen is the only field that can move. Collapsing
      // these into one statement is what keeps a full-suite run off the transaction timeout.
      await tx.testIdentity.updateMany({
        where: { id: { in: [...new Set(refreshed.map(settle))] } },
        data: { lastSeenAt: startedAt },
      })
    }

    for (const update of rewritten) {
      await tx.testIdentity.update({ where: { id: settle(update.identityId) }, data: update.data })
    }

    if (stitches.length > 0) {
      await tx.identityStitch.createMany({
        data: stitches.map((row) => ({ ...row, testIdentityId: settle(row.testIdentityId) })),
      })
    }

    for (const id of assignments) affected.add(settle(id))
    for (const event of createdEvents) event.testIdentityId = settle(event.testIdentityId)

    const prior = await tx.testExecution.findMany({
      where: { runId: run.id },
      select: { id: true, ordinal: true },
    })
    // Reprocessing the same idempotency key has to keep execution ids stable — RCA reports
    // and artifacts reference them — so reuse what is already stored for each ordinal.
    const executionIds: string[] = prepared.map(() => randomUUID())
    for (const row of prior) {
      if (row.ordinal != null && row.ordinal < executionIds.length)
        executionIds[row.ordinal] = row.id
    }

    const executionFields = prepared.map(({ execution }, ordinal) => ({
      testIdentityId: settle(assignments[ordinal]!),
      attempt: execution.attempt,
      retryOf:
        execution.retryOfIndex != null && execution.retryOfIndex < ordinal
          ? (executionIds[execution.retryOfIndex] ?? null)
          : null,
      status: execution.status,
      durationMs: execution.durationMs,
      errorMessage: execution.error?.message ?? null,
      otelTraceId: execution.traceId ?? batch.run.traceId ?? null,
      otelSpanId: execution.spanId ?? null,
      artifactsRef: (execution.artifacts ?? null) as Prisma.InputJsonValue,
      attributes: (execution.attributes ?? null) as Prisma.InputJsonValue,
      spans: (execution.spans ?? null) as Prisma.InputJsonValue,
      startedAt: execution.startedAt,
    }))

    if (prior.length === 0) {
      await tx.testExecution.createMany({
        data: executionFields.map((fields, ordinal) => ({
          ...tenant,
          id: executionIds[ordinal]!,
          runId: run.id,
          ordinal,
          ...fields,
        })),
      })
    } else {
      for (const [ordinal, fields] of executionFields.entries()) {
        await tx.testExecution.upsert({
          where: { runId_ordinal: { runId: run.id, ordinal } },
          create: { ...tenant, id: executionIds[ordinal]!, runId: run.id, ordinal, ...fields },
          update: fields,
          select: { id: true },
        })
      }
    }

    for (const [ordinal, { execution }] of prepared.entries()) {
      if (!execution.error) continue
      failures.push({
        executionId: executionIds[ordinal]!,
        filePath: execution.filePath,
        suite: execution.suite,
        title: execution.title,
        errorType: execution.error.type ?? null,
        errorMessage: execution.error.message,
        errorStack: execution.error.stack ?? null,
      })
    }

    await tx.testExecution.deleteMany({
      where: {
        runId: run.id,
        OR: [{ ordinal: null }, { ordinal: { gte: batch.executions.length } }],
      },
    })

    return run.id
  }, TRANSACTION_LIMITS)

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

const scoreIdentity = async (
  prisma: PrismaClient,
  identityId: string,
  ctx: ProcessContext,
): Promise<void> => {
  const { result, data, executions, identity, previousQuarantineCandidate } =
    await computeIdentityScore(prisma, ctx.orgId, ctx.projectId, identityId, {
      now: ctx.now,
      threshold: ctx.threshold,
      minSamples: ctx.minSamples,
    })

  const becameFlaky = result.quarantineCandidate && !previousQuarantineCandidate
  const stabilized = !result.quarantineCandidate && previousQuarantineCandidate

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
