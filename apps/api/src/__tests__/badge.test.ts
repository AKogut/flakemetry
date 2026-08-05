import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seedProject = async (badgeToken: string) => {
  const slug = `badge-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: slug, slug, badgeToken },
  })
  return { orgId: org.id, projectId: project.id }
}

describe.skipIf(!hasDb)('GET /badge/:token/:variant', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = buildApp({ prisma })
    await app.ready()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('serves an svg with no credentials at all', async () => {
    const token = `bdg_${randomUUID()}`
    await seedProject(token)

    const response = await app.inject({ method: 'GET', url: `/badge/${token}/health.svg` })

    // GitHub's image proxy sends no headers. If this needed any, every badge would break.
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('image/svg+xml')
    expect(response.body).toContain('<svg')
    expect(response.body).toContain('flaky health')
  })

  it('serves the shields json schema too', async () => {
    const token = `bdg_${randomUUID()}`
    await seedProject(token)

    const response = await app.inject({ method: 'GET', url: `/badge/${token}/health.json` })

    expect(response.json()).toMatchObject({ schemaVersion: 1, label: 'flaky health' })
  })

  it('is cacheable, so a popular README does not become traffic', async () => {
    const token = `bdg_${randomUUID()}`
    await seedProject(token)

    const response = await app.inject({ method: 'GET', url: `/badge/${token}/health.svg` })

    expect(response.headers['cache-control']).toContain('max-age')
    expect(response.headers.etag).toBeDefined()
  })

  it('renders unknown rather than failing for a token that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/badge/nope/health.svg' })

    // A 404 here is a broken image for every reader of the page it is embedded in.
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('unknown')
  })

  it('renders unknown for a variant that does not exist', async () => {
    const token = `bdg_${randomUUID()}`
    await seedProject(token)

    const response = await app.inject({ method: 'GET', url: `/badge/${token}/nonsense.svg` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('unknown')
  })

  it('does not report on a project whose token was not given', async () => {
    const token = `bdg_${randomUUID()}`
    const { projectId } = await seedProject(token)
    await prisma.testIdentity.create({
      data: {
        orgId: (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).orgId,
        projectId,
        fingerprint: randomUUID(),
        filePath: 'a.spec.ts',
        suite: 's',
        title: 't',
      },
    })

    const other = `bdg_${randomUUID()}`
    await seedProject(other)

    const mine = await app.inject({ method: 'GET', url: `/badge/${token}/health.svg` })
    const theirs = await app.inject({ method: 'GET', url: `/badge/${other}/health.svg` })

    expect(mine.body).toContain('100%')
    expect(theirs.body).toContain('no data')
  })

  it('serves every variant', async () => {
    const token = `bdg_${randomUUID()}`
    await seedProject(token)

    for (const variant of ['health', 'flakes', 'quarantined', 'worst']) {
      const response = await app.inject({ method: 'GET', url: `/badge/${token}/${variant}.svg` })
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('<svg')
    }
  })
})
