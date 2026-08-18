import { randomUUID } from 'node:crypto'

import type { IngestRunBatch } from '@flakemetry/contracts'
import { PrismaClient } from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import { processJob } from '../processor'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Round trips, not milliseconds. A wall-clock threshold on a shared CI runner is itself a
 * flaky test, which would be a poor thing to ship from a product about flaky tests — and it
 * would measure the runner rather than the code. Query count is deterministic on any
 * hardware and catches the regression that actually matters here: work that scales with the
 * number of tests instead of staying constant.
 */
const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })

const countQueries = async <T>(work: () => Promise<T>): Promise<{ result: T; queries: number }> => {
  let queries = 0
  const count = (): void => {
    queries += 1
  }
  prisma.$on('query', count)
  try {
    const result = await work()
    return { result, queries }
  } finally {
    // Prisma has no `$off`; a fresh client per measurement would reconnect for every case,
    // so the counter is reset by the caller between runs instead.
    prisma.$on('query', () => undefined)
  }
}

const STARTED_AT = new Date('2026-08-18T10:00:00Z')
const NOW = new Date('2026-08-18T12:00:00Z')

const suiteOf = (size: number): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: randomUUID(),
  resource: {
    ciProvider: 'github_actions',
    commitSha: 'abc1234',
    branch: 'main',
    trigger: 'push',
  },
  run: { status: 'passed', startedAt: STARTED_AT },
  executions: Array.from({ length: size }, (_, index) => ({
    filePath: `src/feature-${index % 50}.spec.ts`,
    suite: `feature ${index % 50}`,
    title: `case ${index}`,
    status: 'pass' as const,
    attempt: 1,
    startedAt: STARTED_AT,
    durationMs: 12,
  })),
})

const ingest = async (size: number): Promise<number> => {
  const slug = `tput-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })

  let queries = 0
  const count = (): void => {
    queries += 1
  }
  prisma.$on('query', count)

  await processJob(prisma, suiteOf(size), {
    orgId: org.id,
    projectId: project.id,
    now: NOW,
    aiEnabled: false,
  })

  return queries
}

/**
 * The ceiling is loose on purpose. It is not a budget to optimise against — it is a trip
 * wire for the shape of the work changing, and a number tight enough to argue about is a
 * number that fails on an unrelated feature.
 */
const ABSOLUTE_CEILING = 200

describe.skipIf(!hasDb)('ingestion throughput', { timeout: 600_000 }, () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('does not issue more queries because there are more tests', async () => {
    const small = await ingest(200)
    const large = await ingest(1000)

    // Five times the tests. Scoring used to cost five reads and a transaction each, so this
    // ratio was about five; it is now flat, and a regression to per-test work shows up here
    // long before anyone notices the wall clock.
    expect(large).toBeLessThan(small * 2)
    expect(large).toBeLessThan(ABSOLUTE_CEILING)
  })

  it('reports what it measured', async () => {
    const queries = await ingest(1000)

    // Printed rather than silently asserted: the number belongs in a pull request that
    // changes it, not only in a threshold nobody reads.
    process.stdout.write(`\ningestion: 1000 executions in ${queries} queries\n`)
    expect(queries).toBeGreaterThan(0)
  })
})

export { countQueries }
