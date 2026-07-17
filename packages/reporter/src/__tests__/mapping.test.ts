import { describe, expect, it } from 'vitest'

import { buildIdempotencyKey, deriveSuite, resolveRunContext, statusFromResult } from '../mapping'

describe('statusFromResult', () => {
  it('maps a first-attempt pass to pass and a retried pass to flaky', () => {
    expect(statusFromResult('passed', 0)).toBe('pass')
    expect(statusFromResult('passed', 1)).toBe('flaky')
  })

  it('maps every failure kind to fail', () => {
    expect(statusFromResult('failed', 0)).toBe('fail')
    expect(statusFromResult('timedOut', 0)).toBe('fail')
    expect(statusFromResult('interrupted', 0)).toBe('fail')
  })

  it('maps skipped to skip', () => {
    expect(statusFromResult('skipped', 0)).toBe('skip')
  })
})

describe('deriveSuite', () => {
  it('joins only describe titles, ignoring root/project/file nodes', () => {
    const suite = deriveSuite([
      { type: 'root', title: '' },
      { type: 'project', title: 'chromium' },
      { type: 'file', title: 'login.spec.ts' },
      { type: 'describe', title: 'auth' },
      { type: 'describe', title: 'login' },
    ])
    expect(suite).toBe('auth > login')
  })

  it('is empty when there are no describe blocks', () => {
    expect(deriveSuite([{ type: 'file', title: 'a.spec.ts' }])).toBe('')
  })
})

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

  it('falls back to local defaults off CI', () => {
    const context = resolveRunContext({})
    expect(context.ciProvider).toBe('local')
    expect(context.trigger).toBe('manual')
    expect(context.prNumber).toBeNull()
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
