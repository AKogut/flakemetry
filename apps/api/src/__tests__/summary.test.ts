import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { renderPrComment, type RunSummary } from '@flakemetry/queries'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const at = (iso: string) => new Date(iso)

const seedRun = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const tenant = { orgId: org.id, projectId: project.id }
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { ...tenant, name: 'ci', tokenHash: hashToken(raw) },
  })

  const flakyId = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-flaky',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      quarantined: true,
    },
  })
  const failId = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-fail',
      filePath: 'e2e/checkout.spec.ts',
      suite: 'shop',
      title: 'pays',
    },
  })
  const passId = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-pass',
      filePath: 'e2e/home.spec.ts',
      suite: 'home',
      title: 'renders',
    },
  })

  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'run-000001',
      commitSha: 'abc1234',
      branch: 'feature/login',
      prNumber: 42,
      ciProvider: 'github_actions',
      trigger: 'pull_request',
      status: 'failed',
      startedAt: at('2026-07-16T10:00:00Z'),
    },
  })

  await prisma.testExecution.createMany({
    data: [
      {
        ...tenant,
        runId: run.id,
        testIdentityId: flakyId.id,
        attempt: 1,
        status: 'fail',
        durationMs: 1800,
        errorMessage: 'Timeout',
        startedAt: at('2026-07-16T10:00:01Z'),
      },
      {
        ...tenant,
        runId: run.id,
        testIdentityId: flakyId.id,
        attempt: 2,
        status: 'flaky',
        durationMs: 1400,
        startedAt: at('2026-07-16T10:00:03Z'),
      },
      {
        ...tenant,
        runId: run.id,
        testIdentityId: failId.id,
        attempt: 1,
        status: 'fail',
        durationMs: 900,
        errorMessage: 'Assertion failed',
        startedAt: at('2026-07-16T10:00:02Z'),
      },
      {
        ...tenant,
        runId: run.id,
        testIdentityId: passId.id,
        attempt: 1,
        status: 'pass',
        durationMs: 500,
        startedAt: at('2026-07-16T10:00:04Z'),
      },
    ],
  })

  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: flakyId.id,
      score: 0.82,
      flipRate: 0.5,
      passOnRerunRate: 0.4,
      sameShaVariance: 0.6,
      entropy: 1,
      failIsolation: 0,
      reasonCodes: [{ code: 'SAME_SHA_VARIANCE', message: 'passed and failed on the same commit' }],
      quarantineCandidate: true,
      modelVersion: '0.2.0',
    },
  })

  return { ...tenant, token: raw }
}

describe.skipIf(!hasDb)('GET /v1/runs/summary', () => {
  beforeEach(async () => {
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('rejects an unauthenticated request', async () => {
    const app = buildApp({ prisma })
    const res = await app.inject({ method: 'GET', url: '/v1/runs/summary?commitSha=abc1234' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects a malformed commit sha', async () => {
    const { token } = await seedRun()
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs/summary?commitSha=nope',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns found:false when no run matches the commit', async () => {
    const { token } = await seedRun()
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs/summary?commitSha=deadbeef',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ found: false })
    await app.close()
  })

  it('summarizes the failed and flaky tests of the run, scoped by token', async () => {
    const { token } = await seedRun()
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs/summary?commitSha=abc1234',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { found: boolean; summary: RunSummary; markdown: string }
    expect(body.found).toBe(true)
    expect(body.summary.failed).toBe(1)
    expect(body.summary.flaky).toBe(1)
    expect(body.summary.prNumber).toBe(42)
    expect(body.summary.tests[0]?.status).toBe('fail')
    expect(body.summary.tests.map((t) => t.title)).toEqual(['pays', 'logs in'])

    expect(body.markdown).toContain('<!-- flakemetry:pr-comment -->')
    expect(body.markdown).toContain('e2e/checkout.spec.ts')
    expect(body.markdown).toContain('0.82 🔒')
    await app.close()
  })
})

describe('renderPrComment', () => {
  const base: RunSummary = {
    commitSha: 'abcdef1234',
    branch: 'main',
    prNumber: 7,
    runStatus: 'passed',
    failed: 0,
    flaky: 0,
    tests: [],
  }

  it('renders a green message when nothing is notable', () => {
    const md = renderPrComment(base)
    expect(md).toContain('<!-- flakemetry:pr-comment -->')
    expect(md).toContain('No flaky or failing tests')
    expect(md).toContain('abcdef1')
  })

  it('renders a table and a reason when tests are notable', () => {
    const md = renderPrComment({
      ...base,
      failed: 1,
      flaky: 1,
      tests: [
        {
          testIdentityId: 'a',
          filePath: 'a.spec.ts',
          suite: 's',
          title: 'boom',
          status: 'fail',
          errorMessage: 'x',
          score: null,
          quarantined: false,
          topReason: null,
          knownIssueRef: null,
        },
        {
          testIdentityId: 'b',
          filePath: 'b.spec.ts',
          suite: 's',
          title: 'wobbles',
          status: 'flaky',
          errorMessage: null,
          score: 0.66,
          quarantined: true,
          topReason: 'same commit, different result',
          knownIssueRef: null,
        },
      ],
    })
    expect(md).toContain('**1 failed**')
    expect(md).toContain('| `a.spec.ts` › boom | failed | — |')
    expect(md).toContain('0.66 🔒')
    expect(md).toContain('Why: same commit, different result')
  })
})
