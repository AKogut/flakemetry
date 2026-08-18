import { analyzeFailure, type LlmProvider, scrubText } from '@flakemetry/ai'
import { computeErrorSignature, errorTokens } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'

import { assignCluster, recordClusterOccurrence, resolveClusterThreshold } from './clustering'
import type { EventBus } from './events'
import { workerMetrics } from './telemetry'

export { resolveClusterThreshold }

export interface FailureRecord {
  executionId: string
  filePath: string
  suite: string
  title: string
  errorType: string | null
  errorMessage: string
  errorStack: string | null
}

export interface RcaContext {
  orgId: string
  projectId: string
  now: Date
  provider?: LlmProvider | null
  aiEnabled?: boolean
  dailyTokenBudget?: number
  events?: EventBus
}

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

export const KNOWN_ISSUE_MODEL = 'known-issue'

interface SignatureGroup {
  signatureId: string
  representative: FailureRecord
  testIdentityId: string | null
  clusterId: string | null
  isNew: boolean
}

/**
 * Reuses a cluster's known-issue answer instead of paying for a fresh analysis.
 * Returns false when the cluster has no known issue, or when this execution already
 * carries a report. No notification is emitted: a failure we already recognise is
 * exactly the noise the known-issue path exists to remove.
 */
const explainFromKnownIssue = async (
  prisma: PrismaClient,
  ctx: RcaContext,
  group: SignatureGroup,
): Promise<boolean> => {
  if (!group.clusterId) return false

  const cluster = await prisma.errorCluster.findFirst({
    where: { id: group.clusterId, projectId: ctx.projectId },
    select: { knownIssueRef: true },
  })
  const knownIssueRef = cluster?.knownIssueRef
  if (!knownIssueRef) return false

  const existing = await prisma.rcaReport.findUnique({
    where: { executionId: group.representative.executionId },
    select: { id: true },
  })
  if (existing) return true

  const prior = await prisma.rcaReport.findFirst({
    where: { projectId: ctx.projectId, signature: { clusterId: group.clusterId } },
    orderBy: { createdAt: 'desc' },
    select: { signatureId: true, summary: true, likelyCause: true, suggestedAction: true },
  })

  await prisma.rcaReport.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      executionId: group.representative.executionId,
      signatureId: group.signatureId,
      summary: prior ? prior.summary : `Known issue ${knownIssueRef}`,
      likelyCause: prior
        ? prior.likelyCause
        : `This failure matches a cluster already tracked as ${knownIssueRef}.`,
      suggestedAction: prior ? prior.suggestedAction : `Follow ${knownIssueRef}.`,
      confidence: 1,
      similarPast: prior
        ? [
            {
              signatureId: prior.signatureId,
              summary: prior.summary,
              resolution: prior.suggestedAction,
            },
          ]
        : [],
      llmModel: KNOWN_ISSUE_MODEL,
      tokenCost: 0,
    },
  })

  workerMetrics.rcaSkipped.add(1)
  return true
}

export const processFailures = async (
  prisma: PrismaClient,
  ctx: RcaContext,
  failures: FailureRecord[],
): Promise<void> => {
  if (failures.length === 0) return

  const clusterThreshold = resolveClusterThreshold()
  const groups = new Map<string, SignatureGroup>()

  for (const failure of failures) {
    const scrubbedMessage = scrubText(failure.errorMessage)
    const scrubbedStack = failure.errorStack == null ? null : scrubText(failure.errorStack)
    const signature = computeErrorSignature(scrubbedMessage, scrubbedStack)
    const execution = await prisma.testExecution.findUnique({
      where: { id: failure.executionId },
      select: { errorSignatureId: true, testIdentityId: true },
    })
    const existing = await prisma.errorSignature.findUnique({
      where: {
        projectId_normalizedHash: {
          projectId: ctx.projectId,
          normalizedHash: signature.normalizedHash,
        },
      },
      select: { id: true, clusterId: true },
    })

    let signatureId: string
    let signatureClusterId: string | null = null
    let isNew = false
    if (existing) {
      signatureId = existing.id
      signatureClusterId = existing.clusterId
      const alreadyCounted = execution?.errorSignatureId === signatureId
      await prisma.errorSignature.update({
        where: { id: signatureId },
        data: {
          ...(alreadyCounted ? {} : { occurrenceCount: { increment: 1 } }),
          lastSeenAt: ctx.now,
        },
      })
      if (existing.clusterId && !alreadyCounted) {
        await recordClusterOccurrence(prisma, existing.clusterId, ctx.now)
      }
    } else {
      const tokens = [...errorTokens(scrubbedMessage, signature.stackTemplate)]
      const assignment = await assignCluster(
        prisma,
        { orgId: ctx.orgId, projectId: ctx.projectId, now: ctx.now },
        { tokens, sampleMessage: scrubbedMessage, threshold: clusterThreshold },
      )
      signatureClusterId = assignment.clusterId
      const created = await prisma.errorSignature.create({
        data: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          normalizedHash: signature.normalizedHash,
          sampleMessage: scrubbedMessage,
          stackTemplate: signature.stackTemplate,
          clusterId: assignment.clusterId,
          tokens,
          firstSeenAt: ctx.now,
          lastSeenAt: ctx.now,
        },
        select: { id: true },
      })
      signatureId = created.id
      await recordClusterOccurrence(prisma, assignment.clusterId, ctx.now)
      isNew = true
    }

    if (execution?.errorSignatureId !== signatureId) {
      await prisma.testExecution.update({
        where: { id: failure.executionId },
        data: { errorSignatureId: signatureId },
      })
    }

    if (!groups.has(signature.normalizedHash))
      groups.set(signature.normalizedHash, {
        signatureId,
        representative: failure,
        testIdentityId: execution?.testIdentityId ?? null,
        clusterId: signatureClusterId,
        isNew,
      })
  }

  // A cluster with a known issue already has its answer. Reusing it costs nothing and
  // keeps repeat failures labelled, so it runs before the provider is even considered:
  // known failures are explained whether or not AI is configured or in budget.
  // Deliberately not restricted to new signatures. A repeat of a signature we already
  // know is exactly the case this exists for, and the analysis path skips those
  // entirely — so without this they would carry no explanation at all.
  for (const group of groups.values()) {
    if (!group.clusterId) continue
    const explained = await explainFromKnownIssue(prisma, ctx, group)
    if (explained) group.isNew = false
  }

  const provider = ctx.provider
  const budget = ctx.dailyTokenBudget ?? 0
  if (!provider || !ctx.aiEnabled || budget <= 0) return

  const spentAgg = await prisma.rcaReport.aggregate({
    where: { projectId: ctx.projectId, createdAt: { gte: startOfUtcDay(ctx.now) } },
    _sum: { tokenCost: true },
  })
  let spent = spentAgg._sum.tokenCost ?? 0

  for (const group of groups.values()) {
    if (!group.isNew) continue
    if (spent >= budget) {
      workerMetrics.rcaBudgetExhausted.add(1)
      // Said out loud, not only counted. A metric nobody self-hosting is scraping is the
      // difference between "analysis is off today" and nobody ever finding out why the
      // explanations stopped.
      ctx.events?.emit('ai.budget.spent', { projectId: ctx.projectId, spent, budget })
      break
    }

    const alreadyReported = await prisma.rcaReport.findFirst({
      where: { signatureId: group.signatureId },
      select: { id: true },
    })
    if (alreadyReported) continue

    const sameTest = group.testIdentityId
      ? await prisma.rcaReport.findMany({
          where: {
            projectId: ctx.projectId,
            signatureId: { not: group.signatureId },
            execution: { testIdentityId: group.testIdentityId },
          },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { signatureId: true, summary: true, suggestedAction: true },
        })
      : []
    const clusterSiblings = group.clusterId
      ? await prisma.rcaReport.findMany({
          where: {
            projectId: ctx.projectId,
            signatureId: { not: group.signatureId },
            signature: { clusterId: group.clusterId },
            ...(group.testIdentityId
              ? { execution: { testIdentityId: { not: group.testIdentityId } } }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { signatureId: true, summary: true, suggestedAction: true },
        })
      : []

    const seenSignatures = new Set<string>()
    const similarPast = [...sameTest, ...clusterSiblings]
      .filter((prior) => {
        if (seenSignatures.has(prior.signatureId)) return false
        seenSignatures.add(prior.signatureId)
        return true
      })
      .slice(0, 4)
      .map((prior) => ({
        signatureId: prior.signatureId,
        summary: prior.summary,
        resolution: prior.suggestedAction,
      }))

    let outcome
    try {
      outcome = await analyzeFailure(provider, {
        testTitle: group.representative.title,
        suite: group.representative.suite,
        filePath: group.representative.filePath,
        error: {
          type: group.representative.errorType,
          message: group.representative.errorMessage,
          stack: group.representative.errorStack,
        },
        similarPast,
      })
    } catch (error) {
      workerMetrics.rcaSkipped.add(1)
      process.stderr.write(
        `worker: rca failed for signature ${group.signatureId}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      continue
    }
    if (!outcome) {
      workerMetrics.rcaSkipped.add(1)
      continue
    }

    await prisma.rcaReport.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        executionId: group.representative.executionId,
        signatureId: group.signatureId,
        summary: outcome.analysis.summary,
        likelyCause: outcome.analysis.likelyCause,
        suggestedAction: outcome.analysis.suggestedAction,
        confidence: outcome.analysis.confidence,
        similarPast,
        llmModel: outcome.model,
        promptVersion: outcome.promptVersion,
        tokenCost: outcome.tokenCost,
      },
    })

    spent += outcome.tokenCost
    workerMetrics.rcaGenerated.add(1)
    ctx.events?.emit('rca.created', {
      executionId: group.representative.executionId,
      projectId: ctx.projectId,
      signatureId: group.signatureId,
      model: outcome.model,
      tokenCost: outcome.tokenCost,
    })
  }
}
