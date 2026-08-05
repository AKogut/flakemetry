import { randomUUID } from 'node:crypto'

import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'
import { openApiDocument, READ_ROUTES } from '../rest'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seed = async (scopes: string[]) => {
  const slug = `rest-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'api', tokenHash: hashToken(raw), scopes },
  })
  return { raw, orgId: org.id, projectId: project.id }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('openapi document', () => {
  it('describes every route that is registered', () => {
    const document = openApiDocument('0.1.0') as { paths: Record<string, unknown> }

    // Generated from the same table that registers the routes, so a spec that disagrees with
    // the implementation is not expressible.
    expect(Object.keys(document.paths)).toHaveLength(READ_ROUTES.length)
    expect(document.paths['/v1/runs/{runId}']).toBeDefined()
  })
})

describe.skipIf(!hasDb)('read API', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = buildApp({ prisma })
    await app.ready()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('serves the openapi document without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ openapi: '3.1.0' })
  })

  it('lists runs for a token carrying the read scope', async () => {
    const { raw } = await seed(['read'])

    const response = await app.inject({ method: 'GET', url: '/v1/runs', headers: bearer(raw) })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ items: [] })
  })

  it('refuses an ingest token on the read API', async () => {
    const { raw } = await seed(['ingest'])

    const response = await app.inject({ method: 'GET', url: '/v1/runs', headers: bearer(raw) })

    // The whole point of scopes: a credential handed to a script or a dashboard must not
    // also be able to forge test data, and the converse must hold too.
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('insufficient_scope')
  })

  it('refuses a read token on the ingest path', async () => {
    const { raw } = await seed(['read'])

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: bearer(raw),
      payload: {},
    })

    expect(response.statusCode).toBe(403)
  })

  it('treats a token with no scopes as ingest-only', async () => {
    const { raw } = await seed([])

    const read = await app.inject({ method: 'GET', url: '/v1/runs', headers: bearer(raw) })

    // Tokens predating scopes must not silently gain read.
    expect(read.statusCode).toBe(403)
  })

  it('rejects an absent token before it looks at scopes', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/runs' })

    expect(response.statusCode).toBe(401)
  })

  it('does not serve another project runs', async () => {
    const mine = await seed(['read'])
    const theirs = await seed(['read'])
    const run = await prisma.run.create({
      data: {
        orgId: theirs.orgId,
        projectId: theirs.projectId,
        idempotencyKey: randomUUID(),
        commitSha: 'abc1234',
        branch: 'main',
        ciProvider: 'local',
        trigger: 'manual',
        status: 'passed',
        startedAt: new Date(),
      },
    })

    const list = await app.inject({ method: 'GET', url: '/v1/runs', headers: bearer(mine.raw) })
    const direct = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}`,
      headers: bearer(mine.raw),
    })

    expect(list.json().items).toEqual([])
    expect(direct.statusCode).toBe(404)
  })

  it('validates query parameters instead of trusting them', async () => {
    const { raw } = await seed(['read'])

    const response = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=99999',
      headers: bearer(raw),
    })

    expect(response.statusCode).toBe(400)
  })

  it('coerces numeric and boolean query parameters', async () => {
    const { raw } = await seed(['read'])

    const response = await app.inject({
      method: 'GET',
      url: '/v1/flaky?limit=5&minScore=0.5&includeQuarantined=false',
      headers: bearer(raw),
    })

    // They arrive as strings; the shared contract expects a number and a boolean.
    expect(response.statusCode).toBe(200)
  })

  it('404s a run that does not exist rather than 500', async () => {
    const { raw } = await seed(['read'])

    const response = await app.inject({
      method: 'GET',
      url: `/v1/runs/${randomUUID()}`,
      headers: bearer(raw),
    })

    expect(response.statusCode).toBe(404)
  })

  it('still lets an ingest token fetch a run summary', async () => {
    const { raw } = await seed(['ingest'])

    const response = await app.inject({
      method: 'GET',
      url: '/v1/runs/summary?commitSha=abc1234',
      headers: bearer(raw),
    })

    // The PR-comment action holds an ingest token and reads this. Scoping must not break it.
    expect(response.statusCode).toBe(200)
  })
})
