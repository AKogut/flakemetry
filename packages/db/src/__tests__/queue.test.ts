import { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { IngestionQueue } from '../queue'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seedProject = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: 'web' },
  })
  return { orgId: org.id, projectId: project.id }
}

const payload = (key: string) => ({ idempotencyKey: key, executions: [] })

describe.skipIf(!hasDb)('IngestionQueue', () => {
  beforeEach(async () => {
    await prisma.ingestionJob.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('enqueues a job and deduplicates by idempotency key', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma)

    const first = await queue.enqueue({
      orgId,
      projectId,
      idempotencyKey: 'run-1',
      payload: payload('run-1'),
    })
    const second = await queue.enqueue({
      orgId,
      projectId,
      idempotencyKey: 'run-1',
      payload: payload('run-1'),
    })

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.jobId).toBe(first.jobId)
    expect(await prisma.ingestionJob.count()).toBe(1)
  })

  it('dequeues with skip-locked, marks processing and hides the job from a second dequeue', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma)
    await queue.enqueue({ orgId, projectId, idempotencyKey: 'a', payload: payload('a') })
    await queue.enqueue({ orgId, projectId, idempotencyKey: 'b', payload: payload('b') })

    const batch = await queue.dequeue(2)
    expect(batch).toHaveLength(2)
    expect(batch[0]?.attempts).toBe(1)

    const empty = await queue.dequeue(2)
    expect(empty).toHaveLength(0)
  })

  it('completes a job and reflects it in depth', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma)
    const { jobId } = await queue.enqueue({
      orgId,
      projectId,
      idempotencyKey: 'c',
      payload: payload('c'),
    })

    expect(await queue.depth()).toBe(1)
    await queue.complete(jobId)
    expect(await queue.depth()).toBe(0)
  })

  it('retries below the attempt cap and dead-letters at the cap', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma, { maxAttempts: 2, baseBackoffMs: 5_000 })
    const { jobId } = await queue.enqueue({
      orgId,
      projectId,
      idempotencyKey: 'd',
      payload: payload('d'),
    })

    await prisma.ingestionJob.update({ where: { id: jobId }, data: { attempts: 1 } })
    const beforeFail = Date.now()
    expect(await queue.fail(jobId, 'boom')).toBe('retry')
    const retried = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(retried.status).toBe('pending')
    expect(retried.visibleAt.getTime()).toBeGreaterThanOrEqual(beforeFail)

    await prisma.ingestionJob.update({ where: { id: jobId }, data: { attempts: 2 } })
    expect(await queue.fail(jobId, 'boom again')).toBe('dead')

    const dead = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(dead.status).toBe('dead')
    expect(dead.lastError).toBe('boom again')
  })
})
