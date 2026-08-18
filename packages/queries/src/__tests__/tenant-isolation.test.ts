import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Prisma, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getBadgeMetrics } from '../badge'
import { getFlakeBisect } from '../bisect'
import { getClusterImpact, getExecutionCluster, setClusterKnownIssue } from '../cluster'
import { getFlakinessCost } from '../cost'
import { listDataRequests } from '../data-request'
import { buildEvalSetFromFeedback } from '../feedback'
import { flakyBoard } from '../flaky'
import { getPrGate } from '../gate'
import { getTeamHealthLeaderboard, getTestHealthMetrics } from '../health'
import { findMergeCandidates, listIdentityChanges } from '../identity'
import { getIngestionHealth } from '../ingestion'
import { getParamBuckets } from '../params'
import { getEffectiveProjectPolicy, listPolicyChanges } from '../policy'
import { setQuarantine } from '../quarantine'
import { getRca } from '../rca'
import { planHistoricalRestitch } from '../restitch'
import { getRun, listRuns } from '../runs'
import { computeIdentityScore } from '../scoring'
import { getRunSummaryByCommit } from '../summary'
import { getTest } from '../tests'
import { getExecutionTrace } from '../trace'
import { collectTrackerCandidates } from '../tracker'
import {
  getDailyTrend,
  getFlakyTrend,
  getProjectHealthKpis,
  getSuiteHealth,
  getTestLeaderboards,
} from '../trends'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()
const NOW = new Date('2026-08-18T12:00:00Z')
const COMMIT = 'abc1234'

interface Tenant {
  orgId: string
  projectId: string
  runId: string
  identityId: string
  executionId: string
  signatureId: string
  clusterId: string
  reportId: string
  userId: string
  ids: string[]
}

/**
 * Both tenants get structurally identical data — same commit sha, same file path, same
 * suite and title. A leak between two tenants that look different is easy to miss; between
 * two that look the same, the only thing distinguishing them is the id, which is exactly
 * what every assertion here checks.
 */
const seedTenant = async (label: string): Promise<Tenant> => {
  const slug = `iso-${label}-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug, repository: 'acme/web', codeowners: '* @team' },
  })
  const tenant = { orgId: org.id, projectId: project.id }
  const user = await prisma.user.create({ data: { email: `${slug}@example.com` } })
  await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } })

  await prisma.projectPolicy.create({ data: { ...tenant, flakyThreshold: 0.5 } })
  await prisma.policyChange.create({
    data: { ...tenant, userId: user.id, field: 'flakyThreshold', newValue: '0.5' },
  })
  await prisma.ingestToken.create({
    data: { ...tenant, name: 'ci', tokenHash: `hash-${slug}` },
  })
  await prisma.ingestionJob.create({
    data: {
      ...tenant,
      idempotencyKey: `job-${slug}`,
      payload: {} as Prisma.InputJsonValue,
      status: 'dead',
      lastError: 'boom',
    },
  })
  await prisma.dataRequest.create({
    data: {
      ...tenant,
      kind: 'export',
      status: 'completed',
      subject: `project ${slug}`,
      actor: 'someone',
      artifactPrefix: `org/${org.id}/proj/${project.id}/`,
    },
  })

  const identity = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: `fp-${slug}`,
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
  })

  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: `run-${slug}`,
      commitSha: COMMIT,
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'failed',
      startedAt: NOW,
      durationMs: 1000,
    },
  })

  const cluster = await prisma.errorCluster.create({ data: { ...tenant, label: 'timeouts' } })
  const signature = await prisma.errorSignature.create({
    data: {
      ...tenant,
      clusterId: cluster.id,
      normalizedHash: `sig-${slug}`,
      sampleMessage: 'Timeout',
      stackTemplate: 'at <anon>',
    },
  })

  const execution = await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run.id,
      testIdentityId: identity.id,
      errorSignatureId: signature.id,
      ordinal: 0,
      status: 'fail',
      attempt: 1,
      durationMs: 100,
      startedAt: NOW,
      otelTraceId: `trace-${slug}`,
      errorMessage: 'Timeout 30000ms exceeded',
    },
  })

  const report = await prisma.rcaReport.create({
    data: {
      ...tenant,
      executionId: execution.id,
      signatureId: signature.id,
      summary: 'timing',
      likelyCause: 'race',
      suggestedAction: 'await it',
      confidence: 0.7,
      similarPast: [] as Prisma.InputJsonValue,
      llmModel: 'test',
      tokenCost: 10,
    },
  })
  await prisma.rcaFeedback.create({
    data: { ...tenant, reportId: report.id, userId: user.id, verdict: 'helpful', correction: 'x' },
  })

  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      score: 0.9,
      flipRate: 0.5,
      passOnRerunRate: 0.6,
      sameShaVariance: 0.4,
      entropy: 0.5,
      failIsolation: 1,
      modelVersion: 'test',
      quarantineCandidate: true,
      lastFlakedAt: NOW,
      reasonCodes: [] as Prisma.InputJsonValue,
    },
  })

  const day = new Date('2026-08-18T00:00:00Z')
  await prisma.dailyTestStats.create({
    data: { ...tenant, testIdentityId: identity.id, day, total: 5, passed: 4, flaky: 1 },
  })
  await prisma.suiteDaily.create({
    data: { ...tenant, suite: 'auth', day, total: 5, passed: 4, flaky: 1 },
  })
  await prisma.flakyTrends.create({ data: { ...tenant, day, flakyCount: 1, avgScore: 0.9 } })
  await prisma.testHealthEvent.create({
    data: { ...tenant, testIdentityId: identity.id, kind: 'flaked', score: 0.9 },
  })
  await prisma.identityChange.create({
    data: {
      ...tenant,
      userId: user.id,
      action: 'split',
      sourceIdentityId: identity.id,
      fingerprint: `fp-${slug}`,
    },
  })
  await prisma.identityStitch.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      level: 'file',
      fromFingerprint: 'old',
      toFilePath: 'e2e/login.spec.ts',
      toTitle: 'logs in',
    },
  })
  await prisma.trackerIssue.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      externalId: '1',
      url: 'https://github.com/a/b/issues/1',
    },
  })

  return {
    orgId: org.id,
    projectId: project.id,
    runId: run.id,
    identityId: identity.id,
    executionId: execution.id,
    signatureId: signature.id,
    clusterId: cluster.id,
    reportId: report.id,
    userId: user.id,
    ids: [
      org.id,
      project.id,
      run.id,
      identity.id,
      execution.id,
      signature.id,
      cluster.id,
      report.id,
    ],
  }
}

let a: Tenant
let b: Tenant

const mentionsOther = (value: unknown): string[] => {
  const text = JSON.stringify(value ?? null)
  return b.ids.filter((id) => text.includes(id))
}

describe.skipIf(!hasDb)('tenant isolation', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    a = await seedTenant('a')
    b = await seedTenant('b')
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('seeds two tenants that are indistinguishable apart from their ids', async () => {
    // Guard the guard. Every assertion below looks for one tenant's ids in the other's
    // results, so if the fixtures were empty or identical the whole file would pass while
    // testing nothing.
    expect(a.projectId).not.toBe(b.projectId)
    expect(await prisma.testExecution.count({ where: { projectId: a.projectId } })).toBe(1)
    expect(await prisma.testExecution.count({ where: { projectId: b.projectId } })).toBe(1)
    expect(mentionsOther({ probe: b.executionId })).toEqual([b.executionId])
  })

  describe('reads scoped to a project never surface another tenant', () => {
    const listReads: [string, () => Promise<unknown>][] = [
      [
        'flakyBoard',
        () => flakyBoard(prisma, a.projectId, { limit: 50, minScore: 0, includeQuarantined: true }),
      ],
      ['listRuns', () => listRuns(prisma, a.projectId, { limit: 50 })],
      ['getBadgeMetrics', () => getBadgeMetrics(prisma, a.projectId, NOW)],
      [
        'getFlakinessCost',
        () =>
          getFlakinessCost(prisma, a.projectId, 30, {
            ciMinuteCost: 1,
            developerHourCost: 1,
            investigationMinutes: 1,
          }),
      ],
      ['getTestHealthMetrics', () => getTestHealthMetrics(prisma, a.projectId, 90)],
      ['getTeamHealthLeaderboard', () => getTeamHealthLeaderboard(prisma, a.projectId, 90)],
      ['listIdentityChanges', () => listIdentityChanges(prisma, a.projectId)],
      ['getIngestionHealth', () => getIngestionHealth(prisma, a.projectId)],
      ['listPolicyChanges', () => listPolicyChanges(prisma, a.projectId)],
      ['getEffectiveProjectPolicy', () => getEffectiveProjectPolicy(prisma, a.projectId, {})],
      ['collectTrackerCandidates', () => collectTrackerCandidates(prisma, a.projectId)],
      ['getSuiteHealth', () => getSuiteHealth(prisma, a.projectId)],
      ['getFlakyTrend', () => getFlakyTrend(prisma, a.projectId)],
      ['getProjectHealthKpis', () => getProjectHealthKpis(prisma, a.projectId)],
      ['getDailyTrend', () => getDailyTrend(prisma, a.projectId)],
      ['getTestLeaderboards', () => getTestLeaderboards(prisma, a.projectId)],
      ['buildEvalSetFromFeedback', () => buildEvalSetFromFeedback(prisma, a.projectId)],
      ['planHistoricalRestitch', () => planHistoricalRestitch(prisma, a.projectId)],
      ['listDataRequests', () => listDataRequests(prisma, { projectId: a.projectId })],
      ['getRunSummaryByCommit', () => getRunSummaryByCommit(prisma, a.projectId, COMMIT)],
      ['getPrGate', () => getPrGate(prisma, a.projectId, COMMIT, { baseBranch: 'main' })],
    ]

    it.each(listReads)('%s', async (_name, call) => {
      expect(mentionsOther(await call())).toEqual([])
    })
  })

  describe('an id belonging to another tenant is not found, not fetched', () => {
    const crossReads: [string, () => Promise<unknown>][] = [
      ['getRun', () => getRun(prisma, a.projectId, b.runId)],
      ['getTest', () => getTest(prisma, a.projectId, b.identityId, 50)],
      ['getExecutionTrace', () => getExecutionTrace(prisma, a.projectId, b.executionId)],
      ['getRca', () => getRca(prisma, a.projectId, b.executionId)],
      ['getExecutionCluster', () => getExecutionCluster(prisma, a.projectId, b.executionId)],
      ['getClusterImpact', () => getClusterImpact(prisma, a.projectId, b.executionId)],
      ['getParamBuckets', () => getParamBuckets(prisma, a.projectId, b.identityId)],
      ['getFlakeBisect', () => getFlakeBisect(prisma, a.projectId, b.identityId)],
      ['findMergeCandidates', () => findMergeCandidates(prisma, a.projectId, b.identityId)],
    ]

    it.each(crossReads)('%s', async (_name, call) => {
      const result = await call()
      // Nothing of the other tenant may come back, and the call must not throw its way
      // into a 500 either — an id from another project is a miss, not an error.
      expect(mentionsOther(result)).toEqual([])
    })
  })

  describe('writes cannot reach across', () => {
    it('setQuarantine refuses a test from another project', async () => {
      const outcome = await setQuarantine(prisma, {
        orgId: a.orgId,
        projectId: a.projectId,
        testIdentityId: b.identityId,
        decision: 'quarantined',
      })

      expect(outcome).toMatchObject({ status: 'rejected' })
      const untouched = await prisma.testIdentity.findUnique({ where: { id: b.identityId } })
      expect(untouched?.quarantined).toBe(false)
      expect(untouched?.quarantineOverride).toBeNull()
    })

    it('setClusterKnownIssue refuses a cluster from another project', async () => {
      await setClusterKnownIssue(prisma, a.projectId, b.clusterId, 'JIRA-1')

      const untouched = await prisma.errorCluster.findUnique({ where: { id: b.clusterId } })
      expect(untouched?.knownIssueRef).toBeNull()
    })

    it('scoring another tenant identity under this project writes nothing of theirs', async () => {
      const scored = await computeIdentityScore(prisma, a.orgId, a.projectId, b.identityId, {
        now: NOW,
      })

      // The window is filtered by project, so a foreign identity scores on no history at
      // all rather than on the other tenant's.
      expect(scored.executions).toEqual([])
    })
  })

  it('each tenant still sees its own data', async () => {
    // Without this the file passes if every query returns nothing, which is the failure
    // mode a leak test is most likely to have.
    const board = await flakyBoard(prisma, a.projectId, {
      limit: 50,
      minScore: 0,
      includeQuarantined: true,
    })
    const run = await getRun(prisma, a.projectId, a.runId)
    const trace = await getExecutionTrace(prisma, a.projectId, a.executionId)

    expect(JSON.stringify(board)).toContain(a.identityId)
    expect(run).not.toBeNull()
    expect(trace).not.toBeNull()
  })
})

/**
 * Every project-scoped query has to be exercised here or excluded on purpose. Without this
 * the suite protects the functions that existed the day it was written, and a leak arrives
 * with the next feature rather than with a change to anything already covered.
 */
const COVERAGE_EXCLUSIONS: Readonly<Record<string, string>> = {
  applyHistoricalRestitch: 'a write over candidates that planHistoricalRestitch already scoped',
  computeIdentityScores: 'the batch behind computeIdentityScore, reached through it',
}

const projectScopedFunctions = (): string[] => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const names: string[] = []

  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const match of source.matchAll(/export const (\w+) = async \(([\s\S]*?)\):\s/g)) {
      const [, name = '', params = ''] = match
      if (/\bprojectId: string/.test(params)) names.push(name)
    }
  }
  return [...new Set(names)]
}

describe('isolation coverage', () => {
  it('exercises every project-scoped query, or says why not', () => {
    const suite = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const found = projectScopedFunctions()

    // Guard the guard: a parse that stopped matching would report nothing missing.
    expect(found.length).toBeGreaterThan(15)
    expect(found).toContain('getRun')

    const uncovered = found.filter(
      (name) => !(name in COVERAGE_EXCLUSIONS) && !suite.includes(`${name}(prisma`),
    )
    expect(
      uncovered,
      'add these to the isolation suite, or to COVERAGE_EXCLUSIONS with the reason',
    ).toEqual([])
  })
})
