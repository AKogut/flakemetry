import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createPrismaClient } from '../index'
import { IngestionQueue } from '../queue'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

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

  describe('a repeated key with different results', () => {
    const job = (key: string, title: string, durationMs = 100) => ({
      idempotencyKey: key,
      executions: [
        { filePath: 'a.spec.ts', suite: '', title, status: 'pass', attempt: 1, durationMs },
      ],
    })

    it('stores every job of a matrix instead of dropping them as re-deliveries', async () => {
      const { orgId, projectId } = await seedProject()
      const queue = new IngestionQueue(prisma)
      const key = 'github_actions-1-1'

      const results = []
      for (const durationMs of [100, 200, 300]) {
        results.push(
          await queue.enqueue({
            orgId,
            projectId,
            idempotencyKey: key,
            payload: job(key, 'logs in', durationMs),
          }),
        )
      }

      expect(results.map((result) => result.deduplicated)).toEqual([false, false, false])
      expect(new Set(results.map((result) => result.jobId)).size).toBe(3)
    })

    it('keeps the stored key and the key inside the batch in step, since the worker reads the latter', async () => {
      const { orgId, projectId } = await seedProject()
      const queue = new IngestionQueue(prisma)
      const key = 'github_actions-2-1'

      await queue.enqueue({ orgId, projectId, idempotencyKey: key, payload: job(key, 'first') })
      await queue.enqueue({ orgId, projectId, idempotencyKey: key, payload: job(key, 'second') })

      const jobs = await prisma.ingestionJob.findMany({ where: { projectId } })
      expect(jobs).toHaveLength(2)
      for (const row of jobs) {
        expect((row.payload as { idempotencyKey: string }).idempotencyKey).toBe(row.idempotencyKey)
      }
    })

    it('still deduplicates when any job of the matrix is delivered again', async () => {
      const { orgId, projectId } = await seedProject()
      const queue = new IngestionQueue(prisma)
      const key = 'github_actions-3-1'
      const send = (title: string) =>
        queue.enqueue({ orgId, projectId, idempotencyKey: key, payload: job(key, title) })

      const first = await send('first')
      const second = await send('second')
      const firstAgain = await send('first')
      const secondAgain = await send('second')

      expect(firstAgain).toEqual({ jobId: first.jobId, deduplicated: true })
      expect(secondAgain).toEqual({ jobId: second.jobId, deduplicated: true })
      expect(await prisma.ingestionJob.count({ where: { projectId } })).toBe(2)
    })

    it('stays within the longest key the batch schema accepts', async () => {
      const { orgId, projectId } = await seedProject()
      const queue = new IngestionQueue(prisma)
      const key = 'k'.repeat(128)

      await queue.enqueue({ orgId, projectId, idempotencyKey: key, payload: job(key, 'first') })
      await queue.enqueue({ orgId, projectId, idempotencyKey: key, payload: job(key, 'second') })

      const jobs = await prisma.ingestionJob.findMany({ where: { projectId } })
      expect(jobs).toHaveLength(2)
      expect(Math.max(...jobs.map((row) => row.idempotencyKey.length))).toBeLessThanOrEqual(128)
    })

    it('treats a job stored before digests existed as the same batch', async () => {
      const { orgId, projectId } = await seedProject()
      const queue = new IngestionQueue(prisma)
      const key = 'github_actions-4-1'
      await prisma.ingestionJob.create({
        data: { orgId, projectId, idempotencyKey: key, payload: job(key, 'old') },
      })

      const result = await queue.enqueue({
        orgId,
        projectId,
        idempotencyKey: key,
        payload: job(key, 'new'),
      })

      expect(result.deduplicated).toBe(true)
    })
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

  it('hands back a batch oldest first, so a replay is processed in the order it was sent', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma)

    const keys = Array.from({ length: 40 }, (_, index) => `run-${index}`)
    for (const key of keys) {
      await queue.enqueue({ orgId, projectId, idempotencyKey: key, payload: payload(key) })
      await new Promise((resolve) => setTimeout(resolve, 3))
    }

    const processed: string[] = []
    for (;;) {
      const jobs = await queue.dequeue(5)
      if (jobs.length === 0) break
      expect(jobs.length).toBeLessThanOrEqual(5)
      processed.push(...jobs.map((job) => job.idempotencyKey))
    }

    expect(processed).toEqual(keys)
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

  it('makes a freshly enqueued job immediately visible to dequeue', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma)

    for (let round = 0; round < 25; round += 1) {
      await queue.enqueue({
        orgId,
        projectId,
        idempotencyKey: `immediate-${round}`,
        payload: payload('immediate'),
      })
      const batch = await queue.dequeue(1)
      expect(batch).toHaveLength(1)
      await queue.complete(batch[0]!.id)
    }
  })

  it('counts in-flight jobs in depth so backpressure sees the real backlog', async () => {
    const { orgId, projectId } = await seedProject()
    const queue = new IngestionQueue(prisma)
    const { jobId } = await queue.enqueue({
      orgId,
      projectId,
      idempotencyKey: 'inflight',
      payload: payload('inflight'),
    })

    await queue.dequeue(1)
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
