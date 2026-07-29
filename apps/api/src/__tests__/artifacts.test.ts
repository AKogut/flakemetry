import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { signArtifacts } from '@flakemetry/queries'
import { createMemoryObjectStore } from '@flakemetry/storage'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seedToken = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'ci', tokenHash: hashToken(raw) },
  })
  return { raw, projectId: project.id }
}

const presignBody = {
  idempotencyKey: 'gh-990001-1',
  artifacts: [
    { executionIndex: 0, name: 'shot.png', contentType: 'image/png', sizeBytes: 2048 },
    { executionIndex: 0, name: 'trace.zip', contentType: 'application/zip', sizeBytes: 4096 },
  ],
}

describe.skipIf(!hasDb)('POST /v1/artifacts/presign', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('presigns upload URLs namespaced to the token project', async () => {
    const { raw, projectId } = await seedToken()
    app = buildApp({ prisma, store: createMemoryObjectStore() })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/presign',
      headers: { authorization: `Bearer ${raw}` },
      payload: presignBody,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: { name: string; key: string; uploadUrl: string }[] }
    expect(body.items).toHaveLength(2)
    expect(body.items[0]?.key).toContain(`proj/${projectId}/run/gh-990001-1/0/shot.png`)
    expect(body.items[0]?.uploadUrl).toContain('upload=1')
  })

  it('rejects an unsupported content type with 415', async () => {
    const { raw } = await seedToken()
    app = buildApp({ prisma, store: createMemoryObjectStore() })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/presign',
      headers: { authorization: `Bearer ${raw}` },
      payload: {
        idempotencyKey: 'gh-990001-1',
        artifacts: [
          {
            executionIndex: 0,
            name: 'evil.exe',
            contentType: 'application/x-msdownload',
            sizeBytes: 10,
          },
        ],
      },
    })

    expect(res.statusCode).toBe(415)
  })

  it('returns 501 when no object store is configured', async () => {
    const { raw } = await seedToken()
    app = buildApp({ prisma, store: null })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/presign',
      headers: { authorization: `Bearer ${raw}` },
      payload: presignBody,
    })

    expect(res.statusCode).toBe(501)
  })

  it('rejects requests without a token', async () => {
    app = buildApp({ prisma, store: createMemoryObjectStore() })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/artifacts/presign',
      payload: presignBody,
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('signArtifacts', () => {
  it('signs refs that carry a key and leaves keyless refs unsigned', async () => {
    const store = createMemoryObjectStore()
    const signed = await signArtifacts(store, [
      {
        name: 'shot.png',
        contentType: 'image/png',
        path: 'a/shot.png',
        key: 'org/o/proj/p/0/shot.png',
        sizeBytes: 12,
      },
      { name: 'local.png', contentType: 'image/png', path: 'a/local.png' },
    ])

    expect(signed[0]?.url).toContain('org/o/proj/p/0/shot.png')
    expect(signed[0]?.sizeBytes).toBe(12)
    expect(signed[1]?.url).toBeNull()
  })
})
