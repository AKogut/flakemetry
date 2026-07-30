import type { LlmProvider } from '@flakemetry/ai'
import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEventBus, type DomainEventMap } from '../events'
import { type FailureRecord, processFailures } from '../rca'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()
const NOW = new Date('2026-07-27T12:00:00Z')

const RCA_JSON =
  '{"summary":"network flake","likelyCause":"slow upstream","suggestedAction":"add retry","confidence":0.6}'

const fakeProvider = (text = RCA_JSON): LlmProvider => ({
  name: 'fake',
  model: 'fake-model',
  complete: vi.fn(async () => ({ text, inputTokens: 80, outputTokens: 20 })),
})

const seed = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${Date.now()}` },
  })
  const tenant = { orgId: org.id, projectId: project.id }
  const identity = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: `fp-${Date.now()}`,
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
    },
  })
  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: `run-${Date.now()}`,
      commitSha: 'abc1234',
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'failed',
      startedAt: NOW,
    },
  })
  const execution = await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run.id,
      testIdentityId: identity.id,
      attempt: 1,
      status: 'fail',
      durationMs: 1800,
      errorMessage: 'Timeout 30000ms exceeded for andrii@example.com',
      startedAt: NOW,
    },
  })
  return { ...tenant, executionId: execution.id }
}

const failure = (
  executionId: string,
  message = 'Timeout 30000ms exceeded for andrii@example.com',
): FailureRecord => ({
  executionId,
  filePath: 'e2e/login.spec.ts',
  suite: 'auth',
  title: 'logs in',
  errorType: 'TimeoutError',
  errorMessage: message,
  errorStack: null,
})

describe.skipIf(!hasDb)('processFailures', () => {
  beforeEach(async () => {
    await prisma.rcaReport.deleteMany()
    await prisma.errorSignature.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates an error signature, links the execution, and scrubs the sample message', async () => {
    const ctx = await seed()
    await processFailures(prisma, { orgId: ctx.orgId, projectId: ctx.projectId, now: NOW }, [
      failure(ctx.executionId),
    ])

    const signature = await prisma.errorSignature.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    expect(signature.sampleMessage).toContain('[REDACTED_EMAIL]')
    expect(signature.sampleMessage).not.toContain('andrii@example.com')

    const execution = await prisma.testExecution.findUniqueOrThrow({
      where: { id: ctx.executionId },
    })
    expect(execution.errorSignatureId).toBe(signature.id)
  })

  it('generates a budget-gated RCA report for a new signature when AI is enabled', async () => {
    const ctx = await seed()
    const events = createEventBus()
    const seen: DomainEventMap['rca.created'][] = []
    events.on('rca.created', (payload) => seen.push(payload))

    await processFailures(
      prisma,
      {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        now: NOW,
        provider: fakeProvider(),
        aiEnabled: true,
        dailyTokenBudget: 200_000,
        events,
      },
      [failure(ctx.executionId)],
    )

    const report = await prisma.rcaReport.findFirstOrThrow({ where: { projectId: ctx.projectId } })
    expect(report.likelyCause).toBe('slow upstream')
    expect(report.tokenCost).toBe(100)
    expect(report.llmModel).toBe('fake-model')
    expect(seen).toHaveLength(1)
  })

  it('does not call the model when AI is disabled', async () => {
    const ctx = await seed()
    const provider = fakeProvider()
    await processFailures(
      prisma,
      {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        now: NOW,
        provider,
        aiEnabled: false,
        dailyTokenBudget: 200_000,
      },
      [failure(ctx.executionId)],
    )
    expect(provider.complete).not.toHaveBeenCalled()
    expect(await prisma.rcaReport.count()).toBe(0)
    expect(await prisma.errorSignature.count()).toBe(1)
  })

  it('skips RCA once the daily token budget is already spent', async () => {
    const ctx = await seed()
    const priorSignature = await prisma.errorSignature.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        normalizedHash: 'prior',
        sampleMessage: 'x',
        stackTemplate: '',
      },
    })
    await prisma.rcaReport.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        executionId: ctx.executionId,
        signatureId: priorSignature.id,
        summary: 's',
        likelyCause: 'c',
        suggestedAction: 'a',
        confidence: 0.5,
        similarPast: [],
        llmModel: 'x',
        tokenCost: 200_000,
        createdAt: NOW,
      },
    })

    const other = await prisma.testExecution.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        runId: (await prisma.run.findFirstOrThrow({ where: { projectId: ctx.projectId } })).id,
        testIdentityId: (
          await prisma.testIdentity.findFirstOrThrow({ where: { projectId: ctx.projectId } })
        ).id,
        attempt: 1,
        status: 'fail',
        durationMs: 500,
        errorMessage: 'Element not found in the DOM',
        startedAt: NOW,
      },
    })

    const provider = fakeProvider()
    await processFailures(
      prisma,
      {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        now: NOW,
        provider,
        aiEnabled: true,
        dailyTokenBudget: 200_000,
      },
      [failure(other.id, 'Element not found in the DOM')],
    )
    expect(provider.complete).not.toHaveBeenCalled()
    expect(await prisma.rcaReport.count()).toBe(1)
  })

  it('links prior root causes on the same test as similarPast', async () => {
    const ctx = await seed()
    const provider = fakeProvider()
    const aiCtx = {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      now: NOW,
      provider,
      aiEnabled: true,
      dailyTokenBudget: 200_000,
    }

    await processFailures(prisma, aiCtx, [failure(ctx.executionId)])

    const firstSignature = await prisma.errorSignature.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })

    const second = await prisma.testExecution.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        runId: (await prisma.run.findFirstOrThrow({ where: { projectId: ctx.projectId } })).id,
        testIdentityId: (
          await prisma.testIdentity.findFirstOrThrow({ where: { projectId: ctx.projectId } })
        ).id,
        attempt: 1,
        status: 'fail',
        durationMs: 900,
        errorMessage: 'Element not found in the DOM',
        startedAt: NOW,
      },
    })

    await processFailures(prisma, aiCtx, [failure(second.id, 'Element not found in the DOM')])

    const secondReport = await prisma.rcaReport.findFirstOrThrow({
      where: { executionId: second.id },
    })
    const similar = secondReport.similarPast as {
      signatureId: string
      summary: string
      resolution: string | null
    }[]
    expect(similar).toHaveLength(1)
    expect(similar[0]?.signatureId).toBe(firstSignature.id)
    expect(similar[0]?.summary).toBe('network flake')
    expect(similar[0]?.resolution).toBe('add retry')
  })

  it('clusters near-duplicate signatures together and keeps unrelated ones apart', async () => {
    const ctx = await seed()
    const run = await prisma.run.findFirstOrThrow({ where: { projectId: ctx.projectId } })
    const identity = await prisma.testIdentity.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    const makeExecution = async (message: string) =>
      prisma.testExecution.create({
        data: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          runId: run.id,
          testIdentityId: identity.id,
          attempt: 1,
          status: 'fail',
          durationMs: 500,
          errorMessage: message,
          startedAt: NOW,
        },
      })

    const loginMsg = 'Element #login is not visible in the viewport'
    const logoutMsg = 'Element #logout is not visible in the viewport'
    const httpMsg = 'Request failed with status code 500 Internal Server Error'
    const a = await makeExecution(loginMsg)
    const b = await makeExecution(logoutMsg)
    const c = await makeExecution(httpMsg)

    await processFailures(prisma, { orgId: ctx.orgId, projectId: ctx.projectId, now: NOW }, [
      failure(a.id, loginMsg),
      failure(b.id, logoutMsg),
      failure(c.id, httpMsg),
    ])

    const signatures = await prisma.errorSignature.findMany({
      where: { projectId: ctx.projectId },
      select: { sampleMessage: true, clusterId: true },
    })
    expect(signatures).toHaveLength(3)
    const clusterOf = (needle: string) =>
      signatures.find((row) => row.sampleMessage.includes(needle))?.clusterId

    expect(clusterOf('#login')).toBeTruthy()
    expect(clusterOf('#login')).toBe(clusterOf('#logout'))
    expect(clusterOf('status code')).not.toBe(clusterOf('#login'))
  })

  it('dedupes a repeated signature and only reports it once', async () => {
    const ctx = await seed()
    const second = await prisma.testExecution.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        runId: (await prisma.run.findFirstOrThrow({ where: { projectId: ctx.projectId } })).id,
        testIdentityId: (
          await prisma.testIdentity.findFirstOrThrow({ where: { projectId: ctx.projectId } })
        ).id,
        attempt: 1,
        status: 'fail',
        durationMs: 1200,
        errorMessage: 'Timeout 45000ms exceeded for bob@example.com',
        startedAt: NOW,
      },
    })
    const provider = fakeProvider()

    await processFailures(
      prisma,
      {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        now: NOW,
        provider,
        aiEnabled: true,
        dailyTokenBudget: 200_000,
      },
      [
        failure(ctx.executionId),
        failure(second.id, 'Timeout 45000ms exceeded for bob@example.com'),
      ],
    )

    expect(await prisma.errorSignature.count()).toBe(1)
    const signature = await prisma.errorSignature.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    expect(signature.occurrenceCount).toBe(2)
    expect(await prisma.rcaReport.count()).toBe(1)
    expect(provider.complete).toHaveBeenCalledTimes(1)
  })
})
