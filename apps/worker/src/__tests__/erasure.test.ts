import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import { requestErasure } from '@flakemetry/queries'
import { createMemoryObjectStore, projectArtifactPrefix } from '@flakemetry/storage'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { runErasureSweep } from '../erasure'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seed = async () => {
  const slug = `erase-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug } })
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

  const prefix = projectArtifactPrefix(org.id, project.id)
  const { id } = await requestErasure(prisma, {
    target: { kind: 'project', id: project.id, orgId: org.id, artifactPrefix: prefix },
    subject: `project "Web" (${slug})`,
    actor: 'owner@example.com',
  })

  return { requestId: id, orgId: org.id, projectId: project.id, prefix }
}

describe.skipIf(!hasDb)('erasure sweep', () => {
  beforeEach(async () => {
    await prisma.dataRequest.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('erases what was requested and marks the record complete', async () => {
    const target = await seed()
    const store = createMemoryObjectStore()
    await store.put(`${target.prefix}run/r/0/shot.png`, new Uint8Array([1]), 'image/png')

    const result = await runErasureSweep(prisma, store)

    expect(result).toEqual({ completed: 1, failed: 0 })
    expect(await prisma.project.count({ where: { id: target.projectId } })).toBe(0)
    expect(await store.list(target.prefix)).toEqual([])

    const record = await prisma.dataRequest.findUnique({ where: { id: target.requestId } })
    expect(record?.status).toBe('completed')
    expect(record?.artifactCount).toBe(1)
    expect(record?.rowCount).toBeGreaterThan(0)
  })

  it('has nothing to do when no deletion was requested', async () => {
    expect(await runErasureSweep(prisma, null)).toEqual({ completed: 0, failed: 0 })
  })

  it('does not run the same request twice', async () => {
    await seed()

    const first = await runErasureSweep(prisma, null)
    const second = await runErasureSweep(prisma, null)

    expect(first.completed).toBe(1)
    expect(second).toEqual({ completed: 0, failed: 0 })
  })

  it('says so loudly when data survived the erasure', async () => {
    const target = await seed()
    const notices: string[] = []
    const stubborn = {
      name: 'stubborn',
      list: async () => [{ key: `${target.prefix}stuck.png`, size: 1, lastModified: new Date() }],
      remove: async () => undefined,
      presignUpload: async () => '',
      presignDownload: async () => '',
      put: async () => undefined,
    }

    const result = await runErasureSweep(prisma, stubborn, (message) => notices.push(message))

    // A tenant told their data was deleted while some of it is still in the bucket is the
    // one outcome that must never pass quietly.
    expect(result).toEqual({ completed: 0, failed: 1 })
    expect(notices[0]).toContain('left data behind')

    const record = await prisma.dataRequest.findUnique({ where: { id: target.requestId } })
    expect(record?.status).toBe('failed')
    expect(record?.residue).toMatchObject({ artifacts: 1 })
  })
})
