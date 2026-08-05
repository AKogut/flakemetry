import { randomUUID } from 'node:crypto'

import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seed = async (scopes: string[]) => {
  const slug = `quar-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'api', tokenHash: hashToken(raw), scopes },
  })
  const identity = await prisma.testIdentity.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      fingerprint: `fp-${slug}`,
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
    },
  })
  return { raw, orgId: org.id, projectId: project.id, testId: identity.id }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe.skipIf(!hasDb)('quarantine endpoint', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = buildApp({ prisma })
    await app.ready()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('quarantines a test for a token carrying the quarantine scope', async () => {
    const { raw, testId } = await seed(['quarantine'])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined', reason: 'known bad' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ quarantined: true, override: 'quarantined' })

    const after = await prisma.testIdentity.findUniqueOrThrow({ where: { id: testId } })
    expect(after.quarantined).toBe(true)
    expect(after.quarantineReason).toBe('known bad')
  })

  it('refuses a read token', async () => {
    const { raw, testId } = await seed(['read'])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined' },
    })

    // Reading a dashboard and silencing a failing test are not the same authority.
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('insufficient_scope')
  })

  it('refuses an ingest token', async () => {
    const { raw, testId } = await seed(['ingest'])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined' },
    })

    // This is the credential pasted into every CI job in the company. It reports results;
    // it does not get to decide which results stop mattering.
    expect(response.statusCode).toBe(403)
  })

  it('refuses a request with no token', async () => {
    const { testId } = await seed(['quarantine'])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      payload: { decision: 'quarantined' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('cannot reach a test in another project', async () => {
    const mine = await seed(['quarantine'])
    const theirs = await seed(['quarantine'])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${theirs.testId}/quarantine`,
      headers: bearer(mine.raw),
      payload: { decision: 'quarantined' },
    })

    expect(response.statusCode).toBe(404)
    const untouched = await prisma.testIdentity.findUniqueOrThrow({ where: { id: theirs.testId } })
    expect(untouched.quarantined).toBe(false)
  })

  it('rejects a decision it does not know', async () => {
    const { raw, testId } = await seed(['quarantine'])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'delete-everything' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('hands a test back to the scorer without changing its state', async () => {
    const { raw, testId } = await seed(['quarantine'])
    await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined' },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'auto' },
    })

    expect(response.json()).toMatchObject({ quarantined: true, override: null })
    const after = await prisma.testIdentity.findUniqueOrThrow({ where: { id: testId } })
    expect(after.quarantineOverride).toBeNull()
    expect(after.quarantined).toBe(true)
  })

  it('leaves the test findable on the flaky board it was never scored for', async () => {
    const { raw, testId } = await seed(['quarantine', 'read'])
    expect(await prisma.flakyScore.findUnique({ where: { testIdentityId: testId } })).toBeNull()

    await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined' },
    })

    // The board reads from scores, and until now only the scorer could quarantine — so
    // everything quarantined had one. A test quarantined by hand and absent from every
    // list would be a control whose effect the person cannot see.
    const board = await app.inject({ method: 'GET', url: '/v1/flaky', headers: bearer(raw) })
    const items = board.json().items as { testIdentityId: string; quarantined: boolean }[]
    expect(items.map((item) => item.testIdentityId)).toContain(testId)
    expect(items.find((item) => item.testIdentityId === testId)?.quarantined).toBe(true)
  })

  it('does not overwrite a score the test already has', async () => {
    const { raw, testId, orgId, projectId } = await seed(['quarantine'])
    await prisma.flakyScore.create({
      data: {
        testIdentityId: testId,
        orgId,
        projectId,
        score: 0.42,
        flipRate: 0.1,
        passOnRerunRate: 0.2,
        sameShaVariance: 0.3,
        entropy: 0.4,
        failIsolation: 1,
        modelVersion: 'test',
        reasonCodes: [],
      },
    })

    await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined' },
    })

    // Quarantining is a decision about the build, not a re-measurement.
    const score = await prisma.flakyScore.findUniqueOrThrow({ where: { testIdentityId: testId } })
    expect(score.score).toBe(0.42)
  })

  it('records the change where a person can find it', async () => {
    const { raw, testId, projectId } = await seed(['quarantine'])

    await app.inject({
      method: 'POST',
      url: `/v1/tests/${testId}/quarantine`,
      headers: bearer(raw),
      payload: { decision: 'quarantined', reason: 'flaky in CI only' },
    })

    const changes = await prisma.identityChange.findMany({ where: { projectId } })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.action).toBe('quarantine:quarantined')
    expect(changes[0]?.detail).toContain('flaky in CI only')

    const events = await prisma.testHealthEvent.findMany({ where: { projectId } })
    expect(events.map((event) => event.kind)).toEqual(['quarantined'])
  })
})
