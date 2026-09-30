import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FlakemetryPlugin, IngestRunBatch } from '@flakemetry/contracts'
import { createPrismaAdapter, createPrismaClient, PrismaClient } from '@flakemetry/db'
import { loadPlugins } from '@flakemetry/plugin-host'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { runAnalyzers } from '../plugins'
import { processJob } from '../processor'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()
const examples = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../examples/plugins',
)

const NOW = new Date('2026-09-30T12:00:00Z')

const seedProject = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${Date.now()}` },
  })
  return { orgId: org.id, projectId: project.id }
}

const run = (index: number, durations: Record<string, number>): IngestRunBatch => {
  const startedAt = new Date(Date.UTC(2026, 8, 1 + index, 10))
  return {
    contractVersion: '0.1.0',
    idempotencyKey: `plugin-run-${String(index).padStart(4, '0')}`,
    resource: {
      ciProvider: 'github_actions',
      commitSha: `sha${String(index).padStart(7, '0')}`,
      branch: 'main',
      trigger: 'push',
    },
    run: { status: 'passed', startedAt },
    executions: Object.entries(durations).map(([title, durationMs]) => ({
      filePath: 'e2e/checkout.spec.ts',
      suite: 'checkout',
      title,
      status: 'pass' as const,
      attempt: 1,
      startedAt,
      durationMs,
    })),
  }
}

const signalsFor = async (projectId: string) =>
  prisma.pluginSignal.findMany({
    where: { projectId },
    select: { code: true, plugin: true, message: true, identity: { select: { title: true } } },
  })

describe.skipIf(!hasDb)('analyzer plugins', () => {
  beforeEach(async () => {
    await prisma.pluginSignal.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('stores the reference slow-outlier signal, and clears it once the test is back to normal', async () => {
    const tenant = await seedProject()
    const plugins = await loadPlugins(['./slow-outlier.mjs'], examples)
    const ctx = { ...tenant, now: NOW, plugins }

    for (let index = 0; index < 6; index += 1) {
      await processJob(prisma, run(index, { 'pays by card': 800, 'applies a coupon': 700 }), ctx)
    }
    expect(await signalsFor(tenant.projectId)).toEqual([])

    await processJob(prisma, run(6, { 'pays by card': 4000, 'applies a coupon': 720 }), ctx)
    const raised = await signalsFor(tenant.projectId)
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({
      code: 'SLOW_OUTLIER',
      plugin: 'slow-outlier',
      identity: { title: 'pays by card' },
    })
    expect(raised[0]?.message).toMatch(/took 4\.0s, 5\.0× its median of 0\.8s/)

    await processJob(prisma, run(7, { 'pays by card': 820, 'applies a coupon': 700 }), ctx)
    expect(await signalsFor(tenant.projectId)).toEqual([])
  })

  it('never fails the run when a plugin throws, runs out of time or breaks the contract', async () => {
    const tenant = await seedProject()
    const throwing: FlakemetryPlugin = {
      name: 'throws',
      apiVersion: 1,
      analyze: () => {
        throw new Error('boom')
      },
    }
    const hanging: FlakemetryPlugin = {
      name: 'hangs',
      apiVersion: 1,
      analyze: () => new Promise(() => undefined),
    }
    const wrong: FlakemetryPlugin = {
      name: 'wrong',
      apiVersion: 1,
      analyze: () =>
        [{ testIdentityId: 'nope', code: 'x', severity: 'fatal', message: '' }] as never,
    }

    const result = await processJob(prisma, run(0, { 'pays by card': 800 }), {
      ...tenant,
      now: NOW,
      plugins: [throwing, hanging, wrong],
      pluginTimeoutMs: 50,
    })

    expect(result.executions).toBe(1)
    expect(await prisma.testExecution.count({ where: { projectId: tenant.projectId } })).toBe(1)
    expect(await signalsFor(tenant.projectId)).toEqual([])
  })

  it('ignores signals for tests that are not in the run', async () => {
    const tenant = await seedProject()
    const other = await seedProject()
    await processJob(prisma, run(0, { 'lives elsewhere': 800 }), { ...other, now: NOW })
    const foreign = await prisma.testIdentity.findFirstOrThrow({
      where: { projectId: other.projectId },
    })

    const reaching: FlakemetryPlugin = {
      name: 'reaches-out',
      apiVersion: 1,
      analyze: () => [
        { testIdentityId: foreign.id, code: 'CROSS_TENANT', severity: 'warning', message: 'no' },
      ],
    }
    await processJob(prisma, run(1, { 'pays by card': 800 }), {
      ...tenant,
      now: NOW,
      plugins: [reaching],
    })

    expect(await prisma.pluginSignal.count()).toBe(0)
  })

  it('reads history in one query however many tests the run has', async () => {
    const tenant = await seedProject()
    const titles = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`test ${index}`, 800]))
    await processJob(prisma, run(0, titles(200)), { ...tenant, now: NOW })
    const small = await processJob(prisma, run(1, titles(10)), { ...tenant, now: NOW })
    const large = await processJob(prisma, run(2, titles(200)), { ...tenant, now: NOW })

    const counted = new PrismaClient({
      adapter: createPrismaAdapter(),
      log: [{ emit: 'event', level: 'query' }],
    })
    let queries = 0
    counted.$on('query', () => {
      queries += 1
    })
    const plugins = await loadPlugins(['./slow-outlier.mjs'], examples)
    const countFor = async (runId: string) => {
      queries = 0
      await runAnalyzers(counted, plugins, { ...tenant, runId }, { timeoutMs: 5000 })
      return queries
    }

    const forSmall = await countFor(small.runId)
    const forLarge = await countFor(large.runId)
    await counted.$disconnect()

    expect(forLarge).toBe(forSmall)
  })
})
