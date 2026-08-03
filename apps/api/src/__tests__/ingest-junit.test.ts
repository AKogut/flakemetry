import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const JUNIT = `<testsuites>
  <testsuite name="pytest" timestamp="2026-07-16T10:00:00" tests="2">
    <testcase classname="tests.test_login" name="test_logs_in" file="tests/test_login.py" time="0.01" />
    <testcase classname="tests.test_login" name="test_fails" file="tests/test_login.py" time="0.02">
      <failure message="boom" type="AssertionError">tests/test_login.py:9</failure>
    </testcase>
  </testsuite>
</testsuites>`

const body = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: 'junit-run-0001',
  resource: {
    ciProvider: 'github_actions',
    commitSha: 'abc1234',
    branch: 'main',
    trigger: 'push',
  },
  xml: JUNIT,
  ...overrides,
})

const seedToken = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'ci', tokenHash: hashToken(raw) },
  })
  return { raw, projectId: project.id }
}

describe.skipIf(!hasDb)('POST /v1/ingest/junit', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await prisma.ingestionJob.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    app = buildApp({ prisma })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const post = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/ingest/junit',
      headers: { authorization: `Bearer ${token}` },
      payload,
    })

  it('parses the report server-side and enqueues the same batch the CLI would send', async () => {
    const { raw, projectId } = await seedToken()
    const response = await post(raw, body())

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ acceptedExecutions: 2 })

    const job = await prisma.ingestionJob.findFirstOrThrow({ where: { projectId } })
    const payload = job.payload as {
      run: { status: string }
      executions: { title: string; status: string; attempt: number }[]
    }
    expect(job.idempotencyKey).toBe('junit-run-0001')
    // One case failed, so the run failed.
    expect(payload.run.status).toBe('failed')
    expect(payload.executions).toHaveLength(2)
    expect(payload.executions.map((execution) => execution.status).sort()).toEqual(['fail', 'pass'])
    expect(payload.executions.every((execution) => execution.attempt === 1)).toBe(true)
  })

  it('deduplicates a replayed upload rather than double-counting the run', async () => {
    const { raw, projectId } = await seedToken()
    await post(raw, body())
    const second = await post(raw, body())

    expect(second.statusCode).toBe(202)
    expect(second.json()).toMatchObject({ deduplicated: true })
    expect(await prisma.ingestionJob.count({ where: { projectId } })).toBe(1)
  })

  it('rejects an unparseable report and one with no test cases', async () => {
    const { raw } = await seedToken()

    const empty = await post(raw, body({ xml: '<testsuites></testsuites>' }))
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ error: 'empty_report' })

    const malformed = await post(raw, body({ xml: 'not xml at all' }))
    expect(malformed.statusCode).toBe(400)
  })

  it('rejects a payload without run context and an unauthenticated caller', async () => {
    const { raw } = await seedToken()

    const noResource = await post(raw, { idempotencyKey: 'junit-run-0002', xml: JUNIT })
    expect(noResource.statusCode).toBe(400)
    expect(noResource.json()).toMatchObject({ error: 'invalid_payload' })

    const unauthorized = await post('fmk_not_a_real_token', body())
    expect(unauthorized.statusCode).toBe(401)
  })
})
