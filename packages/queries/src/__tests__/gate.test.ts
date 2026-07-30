import { type Prisma, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { getPrGate, type PrGate, renderGateComment } from '../gate'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-07-16T12:00:00Z')
const PR_COMMIT = 'deadbee'

interface Seed {
  projectId: string
  newlyBrokenId: string
  knownFlakeId: string
}

const seed = async (): Promise<Seed> => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: 'web' },
  })
  const tenant = { orgId: org.id, projectId: project.id }

  const newlyBroken = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-new',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
    },
  })
  const knownFlake = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-known',
      filePath: 'e2e/cart.spec.ts',
      suite: 'shop',
      title: 'adds to cart',
    },
  })

  const baseRun = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'base-1',
      commitSha: 'base123',
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'passed',
      startedAt: new Date('2026-07-15T10:00:00Z'),
    },
  })
  await prisma.testExecution.createMany({
    data: [
      {
        ...tenant,
        runId: baseRun.id,
        ordinal: 0,
        testIdentityId: newlyBroken.id,
        attempt: 1,
        status: 'pass',
        durationMs: 900,
        startedAt: new Date('2026-07-15T10:00:01Z'),
      },
      {
        ...tenant,
        runId: baseRun.id,
        ordinal: 1,
        testIdentityId: knownFlake.id,
        attempt: 1,
        status: 'flaky',
        durationMs: 1200,
        startedAt: new Date('2026-07-15T10:00:02Z'),
      },
    ],
  })

  const prRun = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'pr-1',
      commitSha: PR_COMMIT,
      branch: 'feature/x',
      prNumber: 7,
      ciProvider: 'github_actions',
      trigger: 'pull_request',
      status: 'failed',
      startedAt: new Date('2026-07-16T10:00:00Z'),
    },
  })
  await prisma.testExecution.createMany({
    data: [
      {
        ...tenant,
        runId: prRun.id,
        ordinal: 0,
        testIdentityId: newlyBroken.id,
        attempt: 1,
        status: 'fail',
        durationMs: 1800,
        errorMessage: 'Timeout',
        startedAt: new Date('2026-07-16T10:00:01Z'),
      },
      {
        ...tenant,
        runId: prRun.id,
        ordinal: 1,
        testIdentityId: knownFlake.id,
        attempt: 1,
        status: 'fail',
        durationMs: 1400,
        errorMessage: 'Assertion',
        startedAt: new Date('2026-07-16T10:00:02Z'),
      },
    ] as Prisma.TestExecutionCreateManyInput[],
  })

  return { projectId: project.id, newlyBrokenId: newlyBroken.id, knownFlakeId: knownFlake.id }
}

const baseGate = (overrides: Partial<PrGate> = {}): PrGate => ({
  commitSha: 'deadbeefcafe',
  branch: 'feature/login',
  baseBranch: 'main',
  prNumber: 7,
  runStatus: 'failed',
  newFailures: 1,
  knownFlakes: 1,
  strictness: 'new',
  verdict: 'block',
  tests: [
    {
      testIdentityId: 't1',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'fail',
      errorMessage: null,
      topReason: null,
      score: 0,
      quarantined: false,
      classification: 'new_failure',
      baseFailRate: 0,
      baseSampleSize: 0,
    },
    {
      testIdentityId: 't2',
      filePath: 'e2e/cart.spec.ts',
      suite: 'shop',
      title: 'adds to cart',
      status: 'flaky',
      errorMessage: null,
      topReason: null,
      score: 0.7,
      quarantined: false,
      classification: 'known_flake',
      baseFailRate: 0.2,
      baseSampleSize: 10,
    },
  ],
  ...overrides,
})

describe('renderGateComment', () => {
  it('renders verdict, marker and a per-test table', () => {
    const md = renderGateComment(baseGate())
    expect(md).toContain('<!-- flakemetry:pr-gate -->')
    expect(md).toContain('🚫 **Blocked** — 1 new failure(s)')
    expect(md).toContain('| Test | In this run | Verdict | On base |')
    expect(md).toContain('🔴 new failure')
    expect(md).toContain('🟡 known flake')
    expect(md).toContain('20% of 10')
  })

  it('renders a clean pass when nothing failed', () => {
    const md = renderGateComment(
      baseGate({ verdict: 'pass', newFailures: 0, knownFlakes: 0, tests: [] }),
    )
    expect(md).toContain('✅ **Passed** — no failing or flaky tests')
    expect(md).not.toContain('| Test |')
  })

  it('neutralises markdown injection from branch and test fields', () => {
    const md = renderGateComment(
      baseGate({
        branch: '`[click](http://evil)`',
        baseBranch: 'main`\n# pwned',
        tests: [
          {
            testIdentityId: 't1',
            filePath: 'a`.ts',
            suite: 's',
            title: 'boom` | ` <img src=x>',
            status: 'fail',
            errorMessage: null,
            topReason: null,
            score: 0,
            quarantined: false,
            classification: 'new_failure',
            baseFailRate: 0,
            baseSampleSize: 0,
          },
        ],
      }),
    )
    expect(md).not.toMatch(/``/)
    expect(md).not.toMatch(/^#\s*pwned/m)
    const summaryLine = md.split('\n').find((line) => line.includes('click'))
    expect(summaryLine).toMatch(/`\[click\]\(http:\/\/evil\)`/)
    const tableRow = md.split('\n').find((line) => line.includes('boom'))
    expect(tableRow).toBeDefined()
    expect(tableRow).not.toMatch(/``/)
    expect(tableRow).toContain('boom \\|')
  })
})

describe.skipIf(!hasDb)('getPrGate', () => {
  beforeEach(async () => {
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('blocks a genuinely new failure but not a test that already flakes on base', async () => {
    const s = await seed()
    const gate = await getPrGate(prisma, s.projectId, PR_COMMIT, { baseBranch: 'main', now: NOW })

    expect(gate).not.toBeNull()
    expect(gate?.verdict).toBe('block')
    expect(gate?.newFailures).toBe(1)
    expect(gate?.knownFlakes).toBe(1)

    const byId = new Map(gate?.tests.map((test) => [test.testIdentityId, test]))
    expect(byId.get(s.newlyBrokenId)?.classification).toBe('new_failure')
    expect(byId.get(s.knownFlakeId)?.classification).toBe('known_flake')
    expect(byId.get(s.knownFlakeId)?.baseSampleSize).toBe(1)
  })

  it('treats a quarantined test as a known flake even with a clean base', async () => {
    const s = await seed()
    await prisma.testExecution.deleteMany({
      where: { testIdentityId: s.knownFlakeId, run: { branch: 'main' } },
    })
    await prisma.testIdentity.update({
      where: { id: s.knownFlakeId },
      data: { quarantined: true },
    })

    const gate = await getPrGate(prisma, s.projectId, PR_COMMIT, { baseBranch: 'main', now: NOW })
    const known = gate?.tests.find((test) => test.testIdentityId === s.knownFlakeId)
    expect(known?.classification).toBe('known_flake')
  })

  it('never blocks when strictness is off, and blocks any failure when strictness is any', async () => {
    const s = await seed()
    const off = await getPrGate(prisma, s.projectId, PR_COMMIT, {
      baseBranch: 'main',
      strictness: 'off',
      now: NOW,
    })
    expect(off?.verdict).toBe('pass')

    const any = await getPrGate(prisma, s.projectId, PR_COMMIT, {
      baseBranch: 'main',
      strictness: 'any',
      now: NOW,
    })
    expect(any?.verdict).toBe('block')
  })

  it('returns null when no run matches the commit', async () => {
    const s = await seed()
    const gate = await getPrGate(prisma, s.projectId, 'ffffff', { baseBranch: 'main', now: NOW })
    expect(gate).toBeNull()
  })
})
