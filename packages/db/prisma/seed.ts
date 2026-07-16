import { randomUUID } from 'node:crypto'

import type { Prisma, RunStatus, TestStatus } from '@prisma/client'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const createRandom = (initial: number) => {
  let state = initial
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const random = createRandom(42)

const jitter = (base: number, spread: number) => Math.round(base + (random() - 0.5) * 2 * spread)

const HOUR = 3_600_000
const BASE_TIME = new Date('2026-07-01T08:00:00Z').getTime()
const RUN_COUNT = 24

const shaFor = (index: number) => index.toString(16).padStart(8, '0').repeat(5)

type Behavior = 'stable' | 'flakyRetry' | 'flakyRace' | 'regression'

const TESTS: {
  filePath: string
  suite: string
  title: string
  behavior: Behavior
  baseDurationMs: number
}[] = [
  {
    filePath: 'e2e/auth/login.spec.ts',
    suite: 'auth',
    title: 'logs in with valid credentials',
    behavior: 'flakyRetry',
    baseDurationMs: 1800,
  },
  {
    filePath: 'e2e/checkout/payment.spec.ts',
    suite: 'checkout',
    title: 'completes payment with saved card',
    behavior: 'flakyRace',
    baseDurationMs: 3200,
  },
  {
    filePath: 'e2e/api/orders.spec.ts',
    suite: 'api',
    title: 'creates an order via api',
    behavior: 'regression',
    baseDurationMs: 900,
  },
  {
    filePath: 'e2e/auth/logout.spec.ts',
    suite: 'auth',
    title: 'logs out and clears the session',
    behavior: 'stable',
    baseDurationMs: 700,
  },
  {
    filePath: 'e2e/catalog/search.spec.ts',
    suite: 'catalog',
    title: 'filters products by category',
    behavior: 'stable',
    baseDurationMs: 1500,
  },
  {
    filePath: 'e2e/catalog/details.spec.ts',
    suite: 'catalog',
    title: 'renders product details page',
    behavior: 'stable',
    baseDurationMs: 1100,
  },
  {
    filePath: 'e2e/cart/add-remove.spec.ts',
    suite: 'cart',
    title: 'adds and removes items from cart',
    behavior: 'stable',
    baseDurationMs: 2000,
  },
  {
    filePath: 'e2e/profile/settings.spec.ts',
    suite: 'profile',
    title: 'updates notification preferences',
    behavior: 'stable',
    baseDurationMs: 1300,
  },
]

const SIGNATURES = {
  timeout: {
    normalizedHash: 'sig_timeout_locator_click',
    sampleMessage: 'locator.click: Timeout 30000ms exceeded',
    stackTemplate: 'TimeoutError: locator.click: Timeout <N>ms exceeded\n    at <PATH>:<N>:<N>',
  },
  race: {
    normalizedHash: 'sig_race_payment_intent',
    sampleMessage: 'expect(received).toBe(expected): payment status is "processing"',
    stackTemplate: 'Error: expect(received).toBe(expected)\n    at <PATH>:<N>:<N>',
  },
  assertion: {
    normalizedHash: 'sig_api_orders_422',
    sampleMessage: 'apiRequestContext.post: 422 Unprocessable Entity',
    stackTemplate: 'Error: apiRequestContext.post: <N> Unprocessable Entity\n    at <PATH>:<N>:<N>',
  },
}

async function main() {
  await prisma.rcaReport.deleteMany()
  await prisma.flakyScore.deleteMany()
  await prisma.testExecution.deleteMany()
  await prisma.errorSignature.deleteMany()
  await prisma.run.deleteMany()
  await prisma.testIdentity.deleteMany()
  await prisma.project.deleteMany()
  await prisma.org.deleteMany()

  const org = await prisma.org.create({
    data: { name: 'Acme Inc', slug: 'acme' },
  })

  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Acme Web', slug: 'web', defaultBranch: 'main' },
  })

  const tenant = { orgId: org.id, projectId: project.id }

  const identities = await Promise.all(
    TESTS.map((test) =>
      prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint: `sha256:${test.suite}:${test.title.replaceAll(' ', '_')}`,
          filePath: test.filePath,
          suite: test.suite,
          title: test.title,
          firstSeenAt: new Date(BASE_TIME),
          lastSeenAt: new Date(BASE_TIME + RUN_COUNT * 12 * HOUR),
        },
      }),
    ),
  )

  const signatures = Object.fromEntries(
    await Promise.all(
      Object.entries(SIGNATURES).map(async ([key, value]) => {
        const created = await prisma.errorSignature.create({
          data: {
            ...tenant,
            ...value,
            firstSeenAt: new Date(BASE_TIME),
            lastSeenAt: new Date(BASE_TIME + RUN_COUNT * 12 * HOUR),
          },
        })
        return [key, created] as const
      }),
    ),
  )

  const executions: Prisma.TestExecutionCreateManyInput[] = []
  const signatureCounts: Record<string, number> = { timeout: 0, race: 0, assertion: 0 }
  let latestOrdersFailureId: string | null = null

  for (let runIndex = 0; runIndex < RUN_COUNT; runIndex += 1) {
    const isRerun = runIndex % 6 === 5
    const shaIndex = isRerun ? runIndex - 1 : runIndex
    const isPr = runIndex % 3 === 1
    const startedAt = BASE_TIME + runIndex * 12 * HOUR
    const runId = randomUUID()

    let runFailed = false
    let runDurationMs = 0

    for (const [testIndex, test] of TESTS.entries()) {
      const identity = identities[testIndex]
      if (!identity) continue

      const executionStart = startedAt + jitter(60_000, 30_000)
      const durationMs = Math.max(200, jitter(test.baseDurationMs, test.baseDurationMs / 4))
      runDurationMs += durationMs

      let firstStatus: TestStatus = 'pass'
      let signatureKey: keyof typeof SIGNATURES | null = null
      let errorMessage: string | null = null
      let needsRetry = false

      if (test.behavior === 'flakyRetry' && random() < 0.35) {
        firstStatus = 'fail'
        signatureKey = 'timeout'
        errorMessage = SIGNATURES.timeout.sampleMessage
        needsRetry = true
      } else if (test.behavior === 'flakyRace' && (isRerun ? random() < 0.5 : random() < 0.2)) {
        firstStatus = 'fail'
        signatureKey = 'race'
        errorMessage = SIGNATURES.race.sampleMessage
      } else if (test.behavior === 'regression' && runIndex >= RUN_COUNT - 5) {
        firstStatus = 'fail'
        signatureKey = 'assertion'
        errorMessage = SIGNATURES.assertion.sampleMessage
      }

      const firstId = randomUUID()
      executions.push({
        id: firstId,
        ...tenant,
        runId,
        testIdentityId: identity.id,
        attempt: 1,
        status: firstStatus,
        durationMs,
        errorMessage,
        errorSignatureId: signatureKey ? signatures[signatureKey]?.id : null,
        startedAt: new Date(executionStart),
      })
      if (signatureKey) signatureCounts[signatureKey] = (signatureCounts[signatureKey] ?? 0) + 1

      if (test.behavior === 'regression' && firstStatus === 'fail') {
        latestOrdersFailureId = firstId
      }

      if (needsRetry) {
        const retryPasses = random() < 0.85
        const retryId = randomUUID()
        executions.push({
          id: retryId,
          ...tenant,
          runId,
          testIdentityId: identity.id,
          attempt: 2,
          retryOf: firstId,
          status: retryPasses ? 'flaky' : 'fail',
          durationMs: Math.max(200, jitter(test.baseDurationMs, test.baseDurationMs / 4)),
          errorMessage: retryPasses ? null : SIGNATURES.timeout.sampleMessage,
          errorSignatureId: retryPasses ? null : signatures.timeout?.id,
          startedAt: new Date(executionStart + durationMs + 500),
        })
        if (!retryPasses) {
          runFailed = true
          signatureCounts.timeout = (signatureCounts.timeout ?? 0) + 1
        }
      } else if (firstStatus === 'fail') {
        runFailed = true
      }
    }

    const status: RunStatus = runFailed ? 'failed' : 'passed'
    await prisma.run.create({
      data: {
        id: runId,
        ...tenant,
        idempotencyKey: `ci-run-${runIndex + 1}`,
        commitSha: shaFor(shaIndex),
        branch: isPr ? `feat/checkout-v${runIndex}` : 'main',
        prNumber: isPr ? 100 + runIndex : null,
        ciProvider: 'github_actions',
        ciRunId: String(9_000_000 + runIndex),
        trigger: isPr ? 'pull_request' : 'push',
        status,
        startedAt: new Date(startedAt),
        finishedAt: new Date(startedAt + runDurationMs + 120_000),
        durationMs: runDurationMs + 120_000,
        gitDiffStat: { filesChanged: jitter(6, 5), insertions: jitter(120, 100) },
      },
    })
  }

  await prisma.testExecution.createMany({ data: executions })

  await Promise.all(
    Object.entries(signatureCounts).map(([key, count]) =>
      prisma.errorSignature.update({
        where: { id: signatures[key]?.id },
        data: { occurrenceCount: Math.max(1, count) },
      }),
    ),
  )

  const loginIdentity = identities[0]
  const paymentIdentity = identities[1]

  if (loginIdentity) {
    await prisma.flakyScore.create({
      data: {
        ...tenant,
        testIdentityId: loginIdentity.id,
        score: 0.86,
        flipRate: 0.42,
        passOnRerunRate: 0.85,
        sameShaVariance: 0.6,
        entropy: 0.92,
        failIsolation: 0.88,
        reasonCodes: [
          { code: 'PASS_ON_RERUN', message: 'passed on rerun in 85% of retried runs' },
          { code: 'HIGH_FLIP_RATE', message: 'flipped pass/fail 10 times in the last 24 runs' },
          { code: 'FAILS_IN_ISOLATION', message: 'fails alone while sibling tests stay green' },
        ],
        quarantineCandidate: true,
        lastFlakedAt: new Date(BASE_TIME + (RUN_COUNT - 2) * 12 * HOUR),
        modelVersion: '0.1.0',
      },
    })
  }

  if (paymentIdentity) {
    await prisma.flakyScore.create({
      data: {
        ...tenant,
        testIdentityId: paymentIdentity.id,
        score: 0.58,
        flipRate: 0.25,
        passOnRerunRate: 0.3,
        sameShaVariance: 0.5,
        entropy: 0.71,
        failIsolation: 0.62,
        reasonCodes: [
          { code: 'SAME_SHA_VARIANCE', message: 'different results on identical commit shas' },
          { code: 'RERUN_SENSITIVE', message: 'fails twice as often on CI re-runs' },
        ],
        quarantineCandidate: false,
        lastFlakedAt: new Date(BASE_TIME + (RUN_COUNT - 1) * 12 * HOUR),
        modelVersion: '0.1.0',
      },
    })
  }

  if (latestOrdersFailureId) {
    await prisma.rcaReport.create({
      data: {
        ...tenant,
        executionId: latestOrdersFailureId,
        signatureId: signatures.assertion?.id ?? '',
        summary: 'Orders API rejects the payload the test sends since the last five runs',
        likelyCause:
          'The orders service now returns 422 for order creation without the new idempotency header, introduced in the backend change that landed with commit 00000013',
        suggestedAction:
          'Update the test fixture to send the idempotency header, and add a contract test covering the orders POST payload',
        confidence: 0.82,
        similarPast: [],
        llmModel: 'claude-sonnet-5',
        tokenCost: 2148,
      },
    })
  }

  const counts = {
    orgs: await prisma.org.count(),
    projects: await prisma.project.count(),
    identities: await prisma.testIdentity.count(),
    runs: await prisma.run.count(),
    executions: await prisma.testExecution.count(),
    signatures: await prisma.errorSignature.count(),
    flakyScores: await prisma.flakyScore.count(),
    rcaReports: await prisma.rcaReport.count(),
  }
  process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`)
}

main()
  .catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
