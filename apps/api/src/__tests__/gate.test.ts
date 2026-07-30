import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const at = (iso: string) => new Date(iso)
const PR_COMMIT = 'abc1234'

const seedRun = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const tenant = { orgId: org.id, projectId: project.id }
  const raw = generateToken()
  await prisma.ingestToken.create({ data: { ...tenant, name: 'ci', tokenHash: hashToken(raw) } })

  const broken = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-new',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
    },
  })
  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'pr-1',
      commitSha: PR_COMMIT,
      branch: 'feature/x',
      prNumber: 7,
      ciProvider: 'github_actions',
      trigger: 'pull_request',
      status: 'failed',
      startedAt: at('2026-07-16T10:00:00Z'),
    },
  })
  await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run.id,
      testIdentityId: broken.id,
      attempt: 1,
      status: 'fail',
      durationMs: 1800,
      errorMessage: 'Timeout',
      startedAt: at('2026-07-16T10:00:01Z'),
    },
  })

  return { raw }
}

describe.skipIf(!hasDb)('GET /v1/runs/gate', () => {
  beforeEach(async () => {
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
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/gate?commitSha=${PR_COMMIT}&baseBranch=main`,
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('requires a base branch', async () => {
    const { raw } = await seedRun()
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/gate?commitSha=${PR_COMMIT}`,
      headers: { authorization: `Bearer ${raw}` },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('blocks an unseen new failure and renders a gate comment', async () => {
    const { raw } = await seedRun()
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/gate?commitSha=${PR_COMMIT}&baseBranch=main`,
      headers: { authorization: `Bearer ${raw}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      found: boolean
      gate: { verdict: string; newFailures: number }
      markdown: string
    }
    expect(body.found).toBe(true)
    expect(body.gate.verdict).toBe('block')
    expect(body.gate.newFailures).toBe(1)
    expect(body.markdown).toContain('flakemetry:pr-gate')
    await app.close()
  })
})
