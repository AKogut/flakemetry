import { analyzeFailure, type LlmProvider, scrubText } from '@flakemetry/ai'
import { computeErrorSignature } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'

import type { EventBus } from './events'
import { workerMetrics } from './telemetry'

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

interface SignatureGroup {
  signatureId: string
  representative: FailureRecord
  isNew: boolean
}

export const processFailures = async (
  prisma: PrismaClient,
  ctx: RcaContext,
  failures: FailureRecord[],
): Promise<void> => {
  if (failures.length === 0) return

  const groups = new Map<string, SignatureGroup>()

  for (const failure of failures) {
    const scrubbedMessage = scrubText(failure.errorMessage)
    const scrubbedStack = failure.errorStack == null ? null : scrubText(failure.errorStack)
    const signature = computeErrorSignature(scrubbedMessage, scrubbedStack)
    const existing = await prisma.errorSignature.findUnique({
      where: {
        projectId_normalizedHash: {
          projectId: ctx.projectId,
          normalizedHash: signature.normalizedHash,
        },
      },
      select: { id: true },
    })

    let signatureId: string
    let isNew = false
    if (existing) {
      signatureId = existing.id
      await prisma.errorSignature.update({
        where: { id: signatureId },
        data: { occurrenceCount: { increment: 1 }, lastSeenAt: ctx.now },
      })
    } else {
      const created = await prisma.errorSignature.create({
        data: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          normalizedHash: signature.normalizedHash,
          sampleMessage: scrubbedMessage,
          stackTemplate: signature.stackTemplate,
          firstSeenAt: ctx.now,
          lastSeenAt: ctx.now,
        },
        select: { id: true },
      })
      signatureId = created.id
      isNew = true
    }

    await prisma.testExecution.update({
      where: { id: failure.executionId },
      data: { errorSignatureId: signatureId },
    })

    if (!groups.has(signature.normalizedHash))
      groups.set(signature.normalizedHash, { signatureId, representative: failure, isNew })
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
      break
    }

    const alreadyReported = await prisma.rcaReport.findFirst({
      where: { signatureId: group.signatureId },
      select: { id: true },
    })
    if (alreadyReported) continue

    const outcome = await analyzeFailure(provider, {
      testTitle: group.representative.title,
      suite: group.representative.suite,
      filePath: group.representative.filePath,
      error: {
        type: group.representative.errorType,
        message: group.representative.errorMessage,
        stack: group.representative.errorStack,
      },
    })
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
        similarPast: [],
        llmModel: outcome.model,
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
