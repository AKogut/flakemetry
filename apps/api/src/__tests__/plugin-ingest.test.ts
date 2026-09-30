import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FlakemetryPlugin } from '@flakemetry/contracts'
import { createPrismaClient, generateToken, hashToken } from '@flakemetry/db'
import { loadPlugins } from '@flakemetry/plugin-host'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()
const examples = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../examples/plugins',
)

const TAP = `TAP version 13
# Subtest: checkout
    # Subtest: pays by card
    ok 1 - pays by card
      ---
      duration_ms: 12.5
      type: 'test'
      ...
    # Subtest: applies a coupon
    not ok 2 - applies a coupon
      ---
      duration_ms: 3.1
      type: 'test'
      error: 'sentinel-plugin-failure'
      ...
    1..2
not ok 1 - checkout
  ---
  type: 'suite'
  ...
1..1
`

const body = (content: string, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: 'plugin-run-0001',
  resource: { ciProvider: 'github_actions', commitSha: 'abc1234', branch: 'main', trigger: 'push' },
  content,
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

describe.skipIf(!hasDb)('POST /v1/ingest/plugin/:name', () => {
  let plugins: FlakemetryPlugin[] = []
  let app: FastifyInstance

  beforeAll(async () => {
    plugins = await loadPlugins(['./tap.mjs'], examples)
  })

  beforeEach(async () => {
    await prisma.ingestionJob.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const post = (name: string, token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/ingest/plugin/${name}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    })

  it('parses the content with the named plugin and enqueues a run batch', async () => {
    app = buildApp({ prisma, plugins })
    const { raw, projectId } = await seedToken()

    const response = await post('tap', raw, body(TAP))

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ acceptedExecutions: 2 })
    const job = await prisma.ingestionJob.findFirstOrThrow({ where: { projectId } })
    const payload = job.payload as {
      run: { status: string }
      executions: {
        suite: string
        title: string
        status: string
        error: { message: string } | null
      }[]
    }
    expect(payload.run.status).toBe('failed')
    expect(
      payload.executions.map(({ suite, title, status }) => ({ suite, title, status })),
    ).toEqual([
      { suite: 'checkout', title: 'pays by card', status: 'pass' },
      { suite: 'checkout', title: 'applies a coupon', status: 'fail' },
    ])
    expect(payload.executions[1]?.error?.message).toBe('sentinel-plugin-failure')
  })

  it('answers 404 with the loaded plugins for a name nobody loaded', async () => {
    app = buildApp({ prisma, plugins })
    const { raw } = await seedToken()

    const response = await post('junit5', raw, body(TAP))

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: 'unknown_plugin', available: ['tap'] })
  })

  it('refuses output that is not a report, and a parser that throws or hangs', async () => {
    const broken: FlakemetryPlugin[] = [
      { name: 'shapeless', apiVersion: 1, parse: () => ({ tests: [] }) as never },
      {
        name: 'throws',
        apiVersion: 1,
        parse: () => {
          throw new Error('cannot read this')
        },
      },
      { name: 'hangs', apiVersion: 1, parse: () => new Promise(() => undefined) },
    ]
    app = buildApp({ prisma, plugins: broken, pluginTimeoutMs: 50 })
    const { raw, projectId } = await seedToken()

    const shapeless = await post('shapeless', raw, body('x'))
    const throws = await post('throws', raw, body('x'))
    const hangs = await post('hangs', raw, body('x'))

    expect(shapeless.statusCode).toBe(422)
    expect(shapeless.json()).toMatchObject({ error: 'invalid_plugin_output' })
    expect(throws.statusCode).toBe(422)
    expect(throws.json()).toMatchObject({ error: 'plugin_failed', message: 'cannot read this' })
    expect(hangs.statusCode).toBe(422)
    expect(hangs.json().message).toMatch(/did not finish within 50ms/)
    expect(await prisma.ingestionJob.count({ where: { projectId } })).toBe(0)
  })

  it('requires an ingest token like every other ingestion route', async () => {
    app = buildApp({ prisma, plugins })
    const response = await post('tap', 'fmk_not-a-token', body(TAP))
    expect(response.statusCode).toBe(401)
  })
})
