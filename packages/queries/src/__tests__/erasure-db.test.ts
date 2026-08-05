import { type Prisma, PrismaClient } from '@flakemetry/db'
import { createMemoryObjectStore } from '@flakemetry/storage'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { claimErasures, requestErasure } from '../data-request'
import { countByColumn, eraseTarget, tablesWithColumn } from '../erasure'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const START = new Date('2026-08-01T10:00:00Z')
const DAY = new Date('2026-08-01T00:00:00Z')

interface Seed {
  orgId: string
  projectId: string
  prefix: string
}

const seed = async (slug: string): Promise<Seed> => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `${slug}-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug, badgeToken: `bdg_${slug}_${Date.now()}` },
  })
  const tenant = { orgId: org.id, projectId: project.id }
  const user = await prisma.user.create({ data: { email: `${slug}-${Date.now()}@example.com` } })

  await prisma.projectPolicy.create({ data: { ...tenant, flakyThreshold: 0.5 } })
  await prisma.policyChange.create({
    data: { ...tenant, userId: user.id, field: 'flakyThreshold', newValue: '0.5' },
  })
  await prisma.notificationChannel.create({
    data: { ...tenant, kind: 'webhook', target: 'https://hooks.test/x', secret: 'whsec_live' },
  })
  await prisma.ingestToken.create({
    data: { ...tenant, name: 'ci', tokenHash: `hash-${slug}-${Date.now()}` },
  })
  await prisma.ingestionJob.create({
    data: { ...tenant, idempotencyKey: `job-${slug}`, payload: {} as Prisma.InputJsonValue },
  })

  const identity = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: `fp-${slug}`,
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      firstSeenAt: START,
      lastSeenAt: START,
    },
  })

  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: `run-${slug}`,
      commitSha: 'abc1234',
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'failed',
      startedAt: START,
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
      durationMs: 100,
      startedAt: START,
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
    data: { ...tenant, reportId: report.id, userId: user.id, verdict: 'helpful' },
  })

  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      score: 0.8,
      flipRate: 0.4,
      passOnRerunRate: 0.6,
      sameShaVariance: 0.3,
      entropy: 0.5,
      failIsolation: 1,
      modelVersion: 'test',
      reasonCodes: [] as Prisma.InputJsonValue,
    },
  })
  await prisma.dailyTestStats.create({
    data: { ...tenant, testIdentityId: identity.id, day: DAY, total: 1, passed: 1 },
  })
  await prisma.suiteDaily.create({ data: { ...tenant, suite: 'auth', day: DAY, total: 1 } })
  await prisma.flakyTrends.create({ data: { ...tenant, day: DAY, flakyCount: 1 } })
  await prisma.testHealthEvent.create({
    data: { ...tenant, testIdentityId: identity.id, kind: 'flaked' },
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
  await prisma.identityChange.create({
    data: {
      ...tenant,
      userId: user.id,
      action: 'split',
      sourceIdentityId: identity.id,
      fingerprint: `fp-${slug}`,
    },
  })
  await prisma.identityMerge.create({
    data: {
      ...tenant,
      targetIdentityId: identity.id,
      sourceIdentityId: identity.id,
      sourceFingerprint: 'old',
      sourceFilePath: 'e2e/old.spec.ts',
      sourceSuite: 'auth',
      sourceTitle: 'logs in',
      sourceAliases: [],
      sourceFirstSeenAt: START,
      sourceLastSeenAt: START,
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

  return { orgId: org.id, projectId: project.id, prefix: `org/${org.id}/proj/${project.id}/` }
}

const withArtifacts = async (prefix: string, count: number) => {
  const store = createMemoryObjectStore()
  for (let index = 0; index < count; index += 1) {
    await store.put(`${prefix}run/r/0/shot-${index}.png`, new Uint8Array([1]), 'image/png')
  }
  await store.put('org/other/proj/other/keep.png', new Uint8Array([1]), 'image/png')
  return store
}

describe.skipIf(!hasDb)('erasure', () => {
  beforeEach(async () => {
    await prisma.dataRequest.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('finds the project-scoped tables from the database rather than a list in the code', async () => {
    const tables = await tablesWithColumn(prisma, 'project_id')

    // Guard the guard: if this lookup came back empty the residue check below would report
    // a clean erasure for a database that still held everything.
    expect(tables).toContain('test_execution')
    expect(tables).toContain('rca_report')
    expect(tables.length).toBeGreaterThan(15)
  })

  it('leaves nothing behind, in the database or the bucket', async () => {
    const target = await seed('web')
    const store = await withArtifacts(target.prefix, 3)

    const outcome = await eraseTarget(prisma, store, {
      kind: 'project',
      id: target.projectId,
      orgId: target.orgId,
      artifactPrefix: target.prefix,
    })

    expect(outcome.rowsDeleted).toBeGreaterThan(15)
    expect(outcome.artifactsDeleted).toBe(3)
    expect(outcome.residue).toEqual({})
    expect(outcome.verified).toBe(true)
    expect(await store.list(target.prefix)).toEqual([])
    expect(await prisma.project.count({ where: { id: target.projectId } })).toBe(0)
  })

  it('counts rows that are still there, so a clean verdict means something', async () => {
    const target = await seed('web')
    await requestErasure(prisma, {
      target: {
        kind: 'project',
        id: target.projectId,
        orgId: target.orgId,
        artifactPrefix: target.prefix,
      },
      subject: 'project "Web"',
      actor: 'someone@example.com',
    })

    await eraseTarget(prisma, null, {
      kind: 'project',
      id: target.projectId,
      orgId: target.orgId,
      artifactPrefix: target.prefix,
    })

    // The audit row is exempt from the residue check by name. Asked without that
    // exemption, the counter still sees it — so an empty residue is an observation, not
    // the check failing to look.
    const withoutExemptions = await countByColumn(prisma, 'project_id', target.projectId, [])
    expect(withoutExemptions).toEqual({ data_request: 1 })
  })

  it('keeps the audit record the erasure is evidenced by', async () => {
    const target = await seed('web')
    const { id } = await requestErasure(prisma, {
      target: {
        kind: 'project',
        id: target.projectId,
        orgId: target.orgId,
        artifactPrefix: target.prefix,
      },
      subject: 'project "Web" (web)',
      actor: 'someone@example.com',
    })

    await eraseTarget(prisma, null, {
      kind: 'project',
      id: target.projectId,
      orgId: target.orgId,
      artifactPrefix: target.prefix,
    })

    const record = await prisma.dataRequest.findUnique({ where: { id } })
    expect(record?.subject).toBe('project "Web" (web)')
    expect(record?.artifactPrefix).toBe(target.prefix)
  })

  it('does not touch a sibling project in the same workspace', async () => {
    const target = await seed('web')
    const sibling = await prisma.project.create({
      data: { orgId: target.orgId, name: 'Api', slug: 'api' },
    })
    await prisma.run.create({
      data: {
        orgId: target.orgId,
        projectId: sibling.id,
        idempotencyKey: 'run-sibling',
        commitSha: 'def',
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'push',
        status: 'passed',
        startedAt: START,
      },
    })

    await eraseTarget(prisma, null, {
      kind: 'project',
      id: target.projectId,
      orgId: target.orgId,
      artifactPrefix: target.prefix,
    })

    expect(await prisma.run.count({ where: { projectId: sibling.id } })).toBe(1)
  })

  it('erases a whole workspace including every project under it', async () => {
    const target = await seed('web')
    await prisma.project.create({ data: { orgId: target.orgId, name: 'Api', slug: 'api' } })
    const store = await withArtifacts(`org/${target.orgId}/`, 2)

    const outcome = await eraseTarget(prisma, store, {
      kind: 'org',
      id: target.orgId,
      orgId: target.orgId,
      artifactPrefix: `org/${target.orgId}/`,
    })

    expect(outcome.verified).toBe(true)
    expect(await prisma.project.count({ where: { orgId: target.orgId } })).toBe(0)
    expect(await prisma.org.count({ where: { id: target.orgId } })).toBe(0)
    // The other workspace's objects live under a different prefix and must survive.
    expect(await store.list('org/other/')).toHaveLength(1)
  })

  it('runs again after a crash without failing on what the first pass already did', async () => {
    const target = await seed('web')
    const request = {
      kind: 'project' as const,
      id: target.projectId,
      orgId: target.orgId,
      artifactPrefix: target.prefix,
    }

    await eraseTarget(prisma, null, request)
    const second = await eraseTarget(prisma, null, request)

    expect(second.verified).toBe(true)
    expect(second.rowsDeleted).toBe(0)
  })
})

describe.skipIf(!hasDb)('erasure requests', () => {
  beforeEach(async () => {
    await prisma.dataRequest.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('revokes the project tokens the moment the request is made', async () => {
    const target = await seed('web')

    const { tokensRevoked } = await requestErasure(prisma, {
      target: {
        kind: 'project',
        id: target.projectId,
        orgId: target.orgId,
        artifactPrefix: target.prefix,
      },
      subject: 'project "Web"',
      actor: 'someone@example.com',
    })

    // The sweep is up to a minute away and CI does not pause for a deletion request.
    expect(tokensRevoked).toBe(1)
    expect(
      await prisma.ingestToken.count({
        where: { projectId: target.projectId, revokedAt: null },
      }),
    ).toBe(0)
  })

  it('hands a pending request to one worker only', async () => {
    const target = await seed('web')
    await requestErasure(prisma, {
      target: {
        kind: 'project',
        id: target.projectId,
        orgId: target.orgId,
        artifactPrefix: target.prefix,
      },
      subject: 'project "Web"',
      actor: 'someone@example.com',
    })

    const first = await claimErasures(prisma)
    const second = await claimErasures(prisma)

    expect(first).toHaveLength(1)
    expect(first[0]?.target).toMatchObject({ kind: 'project', id: target.projectId })
    expect(second).toEqual([])
  })

  it('picks a request back up when the worker that claimed it died', async () => {
    const target = await seed('web')
    await requestErasure(prisma, {
      target: {
        kind: 'project',
        id: target.projectId,
        orgId: target.orgId,
        artifactPrefix: target.prefix,
      },
      subject: 'project "Web"',
      actor: 'someone@example.com',
    })

    await claimErasures(prisma)
    const later = new Date(Date.now() + 60 * 60 * 1000)
    const retried = await claimErasures(prisma, 5, later)

    // A deletion request that quietly stops halfway is worse than one that never started.
    expect(retried).toHaveLength(1)
  })
})
