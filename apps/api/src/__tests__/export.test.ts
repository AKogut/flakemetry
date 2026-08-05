import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { createMemoryObjectStore, projectArtifactPrefix } from '@flakemetry/storage'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const WEBHOOK_SECRET = 'whsec_do_not_export_me'

const seed = async (scopes: string[]) => {
  const slug = `export-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug } })
  const raw = generateToken()
  const tokenHash = hashToken(raw)

  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'api', tokenHash, scopes },
  })
  await prisma.notificationChannel.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      kind: 'webhook',
      target: 'https://hooks.test/x',
      secret: WEBHOOK_SECRET,
    },
  })
  await prisma.run.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      idempotencyKey: randomUUID(),
      commitSha: 'abc1234',
      branch: 'main',
      ciProvider: 'local',
      trigger: 'manual',
      status: 'passed',
      startedAt: new Date(),
    },
  })

  return { raw, tokenHash, orgId: org.id, projectId: project.id, slug }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

interface Line {
  type: string
  dataset?: string
  data?: Record<string, unknown>
  rows?: number
  artifacts?: number
  counts?: Record<string, number>
}

const archive = (body: Buffer): Line[] =>
  gunzipSync(body)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line)

describe.skipIf(!hasDb)('project export', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = buildApp({ prisma })
    await app.ready()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('streams a manifest, the rows and a closing summary', async () => {
    const { raw } = await seed(['read'])

    const response = await app.inject({ method: 'GET', url: '/v1/export', headers: bearer(raw) })
    const lines = archive(response.rawPayload)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/gzip')
    expect(lines[0]).toMatchObject({ type: 'manifest', version: 1 })
    expect(lines.at(-1)?.type).toBe('summary')
    expect(lines.at(-1)?.counts).toMatchObject({ run: 1, project: 1 })
  })

  it('offers the archive as a named download', async () => {
    const { raw, slug } = await seed(['read'])

    const response = await app.inject({ method: 'GET', url: '/v1/export', headers: bearer(raw) })

    expect(response.headers['content-disposition']).toContain(`flakemetry-${slug}-`)
    expect(response.headers['content-disposition']).toContain('.ndjson.gz')
  })

  it('carries no credential into the archive', async () => {
    const { raw, tokenHash } = await seed(['read'])

    const response = await app.inject({ method: 'GET', url: '/v1/export', headers: bearer(raw) })
    const body = gunzipSync(response.rawPayload).toString('utf8')

    // The export is served on a read credential. Shipping the token hash or a webhook
    // signing secret would turn "download my data" into "take the project's keys".
    expect(body).not.toContain(tokenHash)
    expect(body).not.toContain(WEBHOOK_SECRET)
    // The rows themselves are still there — the omission is a column, not a table.
    expect(body).toContain('hooks.test')
  })

  it('refuses an ingest token', async () => {
    const { raw } = await seed(['ingest'])

    const response = await app.inject({ method: 'GET', url: '/v1/export', headers: bearer(raw) })

    expect(response.statusCode).toBe(403)
  })

  it('refuses a request with no token at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/export' })

    expect(response.statusCode).toBe(401)
  })

  it('exports one project only', async () => {
    const mine = await seed(['read'])
    const theirs = await seed(['read'])

    const response = await app.inject({
      method: 'GET',
      url: '/v1/export',
      headers: bearer(mine.raw),
    })
    const body = gunzipSync(response.rawPayload).toString('utf8')

    expect(body).toContain(mine.projectId)
    expect(body).not.toContain(theirs.projectId)
  })

  it('inventories the artifacts when object storage is configured', async () => {
    const { raw, orgId, projectId } = await seed(['read'])
    const store = createMemoryObjectStore()
    await store.put(
      `${projectArtifactPrefix(orgId, projectId)}run/r/0/shot.png`,
      new Uint8Array([1]),
      'image/png',
    )

    const withStore = buildApp({ prisma, store })
    await withStore.ready()
    const response = await withStore.inject({
      method: 'GET',
      url: '/v1/export',
      headers: bearer(raw),
    })
    await withStore.close()

    const lines = archive(response.rawPayload)
    expect(lines.filter((line) => line.type === 'artifact')).toHaveLength(1)
    expect(lines.at(-1)?.artifacts).toBe(1)
  })

  it('records the export in the audit log', async () => {
    const { raw, projectId } = await seed(['read'])

    await app.inject({ method: 'GET', url: '/v1/export', headers: bearer(raw) })

    const records = await prisma.dataRequest.findMany({ where: { projectId, kind: 'export' } })
    expect(records).toHaveLength(1)
    expect(records[0]?.status).toBe('completed')
    expect(records[0]?.rowCount).toBeGreaterThan(0)
  })
})
