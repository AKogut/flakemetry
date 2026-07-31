import { describe, expect, it } from 'vitest'

import { assertConformantBatch, buildIdempotencyKey, resolveRunContext } from '../runtime'

describe('resolveRunContext', () => {
  it('reads github actions context including pr number from the ref', () => {
    const context = resolveRunContext({
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'abc1234',
      GITHUB_REF_NAME: 'feat/login',
      GITHUB_RUN_ID: '9000001',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/pull/42/merge',
      FLAKEMETRY_PROJECT: 'acme/web',
    })
    expect(context.ciProvider).toBe('github_actions')
    expect(context.trigger).toBe('pull_request')
    expect(context.commitSha).toBe('abc1234')
    expect(context.prNumber).toBe(42)
    expect(context.project).toBe('acme/web')
  })

  it('captures shard index and total when the run is sharded', () => {
    const context = resolveRunContext(
      { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '9000001' },
      { current: 2, total: 4 },
    )
    expect(context.shardIndex).toBe(2)
    expect(context.shardTotal).toBe(4)
  })

  it('ignores a single-shard run', () => {
    const context = resolveRunContext({ GITHUB_ACTIONS: 'true' }, { current: 1, total: 1 })
    expect(context.shardIndex).toBeNull()
    expect(context.shardTotal).toBeNull()
  })

  it('falls back to local defaults off CI', () => {
    const context = resolveRunContext({})
    expect(context.ciProvider).toBe('local')
    expect(context.trigger).toBe('manual')
    expect(context.prNumber).toBeNull()
  })

  it('treats empty-string env vars as absent', () => {
    const context = resolveRunContext({
      GITHUB_SHA: '',
      GITHUB_REF_NAME: '',
      FLAKEMETRY_COMMIT_SHA: 'deadbeef',
    })
    expect(context.commitSha).toBe('deadbeef')
    expect(context.branch).toBe('local')
  })
})

describe('buildIdempotencyKey', () => {
  const base = {
    project: 'acme/web',
    commitSha: 'abc',
    branch: 'main',
    ciProvider: 'github_actions' as const,
    trigger: 'push' as const,
    ciRunId: '9000001',
    prNumber: null,
  }

  it('derives a stable key from the ci run and attempt', () => {
    expect(buildIdempotencyKey(base, { GITHUB_RUN_ATTEMPT: '2' })).toBe('github_actions-9000001-2')
  })

  it('gives each parallel shard a distinct key so they do not overwrite each other', () => {
    const shardOne = buildIdempotencyKey({ ...base, shardIndex: 1, shardTotal: 3 }, {})
    const shardTwo = buildIdempotencyKey({ ...base, shardIndex: 2, shardTotal: 3 }, {})
    expect(shardOne).toBe('github_actions-9000001-1-shard1')
    expect(shardTwo).toBe('github_actions-9000001-1-shard2')
    expect(shardOne).not.toBe(shardTwo)
  })

  it('honors an explicit override', () => {
    expect(buildIdempotencyKey(base, { FLAKEMETRY_IDEMPOTENCY_KEY: 'custom-key-1234' })).toBe(
      'custom-key-1234',
    )
  })

  it('generates a local key when there is no ci run id', () => {
    const key = buildIdempotencyKey({ ...base, ciRunId: null }, {})
    expect(key.startsWith('local-')).toBe(true)
    expect(key.length).toBeGreaterThanOrEqual(8)
  })
})

describe('assertConformantBatch', () => {
  const execution = {
    filePath: 'e2e/login.spec.ts',
    suite: 'auth',
    title: 'logs in',
    status: 'pass' as const,
    attempt: 1,
    startedAt: new Date('2026-07-16T10:00:00Z'),
    durationMs: 100,
  }

  it('accepts a batch with identity-bearing executions', () => {
    expect(() =>
      assertConformantBatch({
        contractVersion: '0.1.0',
        idempotencyKey: 'k',
        resource: { ciProvider: 'local', commitSha: 'abc', branch: 'main', trigger: 'manual' },
        run: { status: 'passed', startedAt: execution.startedAt },
        executions: [execution],
      }),
    ).not.toThrow()
  })

  it('rejects an empty batch and a missing identity', () => {
    const empty = {
      contractVersion: '0.1.0',
      idempotencyKey: 'k',
      resource: {
        ciProvider: 'local' as const,
        commitSha: 'abc',
        branch: 'main',
        trigger: 'manual' as const,
      },
      run: { status: 'passed' as const, startedAt: execution.startedAt },
      executions: [],
    }
    expect(() => assertConformantBatch(empty)).toThrow()
    expect(() =>
      assertConformantBatch({ ...empty, executions: [{ ...execution, title: '' }] }),
    ).toThrow()
  })
})
