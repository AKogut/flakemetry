import { describe, expect, it } from 'vitest'

import {
  CONTRACT_VERSION,
  flakyScoreSchema,
  ingestRunBatchSchema,
  runSchema,
  semverSchema,
  testExecutionSchema,
  testIdentitySchema,
} from '../index'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const validRun = {
  id: uuid(1),
  projectId: uuid(2),
  commitSha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  branch: 'main',
  prNumber: 42,
  ciProvider: 'github_actions',
  ciRunId: '1234567890',
  trigger: 'pull_request',
  status: 'failed',
  startedAt: new Date('2026-07-15T10:00:00Z'),
  finishedAt: new Date('2026-07-15T10:05:00Z'),
  durationMs: 300000,
  gitDiffStat: { filesChanged: 3 },
  otelTraceId: '4bf92f3577b34da6a3ce929d0e0e4736',
}

const validBatch = {
  contractVersion: CONTRACT_VERSION,
  idempotencyKey: 'gh-1234567890-attempt-1',
  resource: {
    ciProvider: 'github_actions',
    ciRunId: '1234567890',
    commitSha: 'a1b2c3d',
    branch: 'feat/login',
    prNumber: 7,
    trigger: 'pull_request',
  },
  run: {
    status: 'failed',
    startedAt: '2026-07-15T10:00:00Z',
    finishedAt: '2026-07-15T10:05:00Z',
  },
  executions: [
    {
      filePath: 'auth/login.spec.ts',
      suite: 'auth',
      title: 'logs in with valid creds',
      status: 'fail',
      attempt: 1,
      startedAt: '2026-07-15T10:01:00Z',
      durationMs: 1834,
      error: {
        type: 'TimeoutError',
        message: 'locator.click: Timeout 30000ms exceeded',
        stack: 'TimeoutError: locator.click: Timeout 30000ms exceeded\n    at login.spec.ts:12:5',
      },
    },
    {
      filePath: 'auth/login.spec.ts',
      suite: 'auth',
      title: 'logs in with valid creds',
      status: 'pass',
      attempt: 2,
      retryOfIndex: 0,
      startedAt: '2026-07-15T10:01:35Z',
      durationMs: 1420,
    },
  ],
}

describe('contract version', () => {
  it('is valid semver', () => {
    expect(semverSchema.safeParse(CONTRACT_VERSION).success).toBe(true)
  })
})

describe('run schema', () => {
  it('parses a valid run', () => {
    expect(runSchema.parse(validRun).id).toBe(validRun.id)
  })

  it('survives a JSON round-trip with date coercion', () => {
    const wire = JSON.parse(JSON.stringify(validRun))
    const parsed = runSchema.parse(wire)
    expect(parsed.startedAt.getTime()).toBe(validRun.startedAt.getTime())
    expect(parsed.finishedAt?.getTime()).toBe(validRun.finishedAt.getTime())
  })

  it('rejects a malformed commit sha', () => {
    expect(runSchema.safeParse({ ...validRun, commitSha: 'not-a-sha!' }).success).toBe(false)
  })

  it('rejects an unknown status', () => {
    expect(runSchema.safeParse({ ...validRun, status: 'exploded' }).success).toBe(false)
  })
})

describe('ingestion batch schema', () => {
  it('parses a valid batch and defaults attempt', () => {
    const parsed = ingestRunBatchSchema.parse(validBatch)
    expect(parsed.executions).toHaveLength(2)
    expect(parsed.executions[1]?.retryOfIndex).toBe(0)
    expect(parsed.run.startedAt).toBeInstanceOf(Date)
  })

  it('rejects a short idempotency key', () => {
    expect(ingestRunBatchSchema.safeParse({ ...validBatch, idempotencyKey: 'x' }).success).toBe(
      false,
    )
  })

  it('rejects negative durations', () => {
    const bad = {
      ...validBatch,
      executions: [{ ...validBatch.executions[0], durationMs: -5 }],
    }
    expect(ingestRunBatchSchema.safeParse(bad).success).toBe(false)
  })
})

describe('flaky score schema', () => {
  it('rejects a score above 1', () => {
    const base = {
      testIdentityId: uuid(3),
      projectId: uuid(2),
      score: 1.2,
      flipRate: 0.4,
      passOnRerunRate: 0.8,
      sameShaVariance: 0.5,
      entropy: 0.9,
      failIsolation: 0.7,
      reasonCodes: [{ code: 'PASS_ON_RERUN', message: 'passed on rerun 4/5 times' }],
      quarantineCandidate: true,
      lastFlakedAt: new Date(),
      modelVersion: '0.1.0',
      updatedAt: new Date(),
    }
    expect(flakyScoreSchema.safeParse(base).success).toBe(false)
    expect(flakyScoreSchema.safeParse({ ...base, score: 0.86 }).success).toBe(true)
  })
})

describe('execution schema', () => {
  it('links retries through retryOf and enforces attempt bounds', () => {
    const execution = {
      id: uuid(10),
      projectId: uuid(2),
      runId: uuid(1),
      testIdentityId: uuid(3),
      attempt: 2,
      retryOf: uuid(9),
      status: 'flaky',
      durationMs: 1500,
      errorMessage: null,
      errorSignatureId: null,
      otelTraceId: null,
      otelSpanId: null,
      artifactsRef: null,
      attributes: null,
      startedAt: new Date(),
    }
    expect(testExecutionSchema.parse(execution).attempt).toBe(2)
    expect(testExecutionSchema.safeParse({ ...execution, attempt: 0 }).success).toBe(false)
  })
})

describe('test identity schema', () => {
  it('carries aliases for stitched history', () => {
    const identity = {
      id: uuid(3),
      projectId: uuid(2),
      fingerprint: 'sha256:abc',
      filePath: 'auth/login.spec.ts',
      suite: 'auth',
      title: 'logs in with valid creds',
      paramsHash: null,
      aliases: ['sha256:old'],
      quarantined: false,
      quarantineReason: null,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }
    expect(testIdentitySchema.parse(identity).aliases).toContain('sha256:old')
  })
})
