import type { ReasonCode, TestDetail } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

import { variantOf } from './params'

interface ExecutionFacts {
  id: string
  has_spans: boolean | null
  has_artifacts: boolean | null
  duration_known: boolean
}

const executionFacts = async (
  prisma: PrismaClient,
  executionIds: string[],
): Promise<Map<string, ExecutionFacts>> => {
  if (executionIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<ExecutionFacts[]>`
    SELECT execution.id::text AS id,
           execution.spans @> '[{}]'::jsonb AS has_spans,
           execution.artifacts_ref @> '[{}]'::jsonb AS has_artifacts,
           EXISTS (
             SELECT 1
             FROM test_execution timed
             WHERE timed.run_id = execution.run_id
               AND timed.status <> 'skip'
               AND timed.duration_ms > 0
           ) AS duration_known
    FROM test_execution execution
    WHERE execution.id = ANY(${executionIds}::uuid[])
  `
  return new Map(rows.map((row) => [row.id, row]))
}

export const getTest = async (
  prisma: PrismaClient,
  projectId: string,
  testIdentityId: string,
  historyLimit: number,
): Promise<TestDetail | null> => {
  const identity = await prisma.testIdentity.findFirst({
    where: { id: testIdentityId, projectId },
    select: {
      id: true,
      fingerprint: true,
      filePath: true,
      suite: true,
      title: true,
      params: true,
      quarantined: true,
      quarantineReason: true,
      quarantineOverride: true,
      quarantineOverrideAt: true,
      aliases: true,
      flakyScore: { select: { score: true, reasonCodes: true } },
      stitches: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          level: true,
          fromFingerprint: true,
          fromFilePath: true,
          fromTitle: true,
          toFilePath: true,
          toTitle: true,
          confidence: true,
          createdAt: true,
          runStartedAt: true,
        },
      },
    },
  })
  if (!identity) return null

  const executions = await prisma.testExecution.findMany({
    where: { testIdentityId, projectId },
    orderBy: [{ startedAt: 'desc' }, { attempt: 'desc' }],
    take: historyLimit,
    select: {
      id: true,
      status: true,
      attempt: true,
      durationMs: true,
      startedAt: true,
      errorMessage: true,
      run: { select: { id: true, commitSha: true, branch: true } },
      rcaReport: { select: { id: true } },
    },
  })

  const facts = await executionFacts(
    prisma,
    executions.map((execution) => execution.id),
  )
  const reasonCodes = (identity.flakyScore?.reasonCodes ?? []) as ReasonCode[]

  return {
    id: identity.id,
    fingerprint: identity.fingerprint,
    filePath: identity.filePath,
    suite: identity.suite,
    title: identity.title,
    variant: variantOf(identity.params),
    quarantined: identity.quarantined,
    quarantineReason: identity.quarantineReason,
    quarantineOverride: identity.quarantineOverride,
    quarantineOverrideAt: identity.quarantineOverrideAt,
    score: identity.flakyScore?.score ?? null,
    reasonCodes,
    aliases: identity.aliases,
    stitches: identity.stitches.map((stitch) => ({
      ...stitch,
      level:
        stitch.level === 'L2'
          ? ('L2' as const)
          : stitch.level === 'manual'
            ? ('manual' as const)
            : ('L3' as const),
    })),
    history: executions
      .map((execution) => {
        const fact = facts.get(execution.id)
        return {
          executionId: execution.id,
          runId: execution.run.id,
          commitSha: execution.run.commitSha,
          branch: execution.run.branch,
          startedAt: execution.startedAt,
          status: execution.status,
          attempt: execution.attempt,
          durationMs: execution.durationMs,
          durationKnown: fact?.duration_known ?? false,
          errorMessage: execution.errorMessage,
          hasRca: execution.rcaReport !== null,
          hasSpans: fact?.has_spans === true,
          hasArtifacts: fact?.has_artifacts === true,
        }
      })
      .reverse(),
  }
}
