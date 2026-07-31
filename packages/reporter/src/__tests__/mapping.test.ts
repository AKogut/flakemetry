import type { TestStep } from '@playwright/test/reporter'
import { describe, expect, it } from 'vitest'

import { deriveSuite, mapSteps, statusFromResult } from '../mapping'

const step = (over: Partial<TestStep> & { category: string; title: string }): TestStep =>
  ({
    startTime: new Date('2026-07-16T10:00:00Z'),
    duration: 100,
    steps: [],
    annotations: [],
    ...over,
  }) as TestStep

describe('mapSteps', () => {
  it('classifies categories into span kinds and preserves nesting', () => {
    const mapped = mapSteps([
      step({
        category: 'test.step',
        title: 'open page',
        steps: [step({ category: 'pw:api', title: 'page.goto' })],
      }),
      step({ category: 'expect', title: 'toBeVisible' }),
    ])

    expect(mapped).toHaveLength(2)
    expect(mapped[0]?.kind).toBe('step')
    expect(mapped[0]?.children?.[0]?.kind).toBe('browser')
    expect(mapped[1]?.kind).toBe('step')
  })

  it('drops attach steps and lifts step errors', () => {
    const mapped = mapSteps([
      step({ category: 'attach', title: 'screenshot' }),
      step({
        category: 'pw:api',
        title: 'click',
        error: { message: 'locator not found', stack: 'at click' },
      }),
    ])

    expect(mapped).toHaveLength(1)
    expect(mapped[0]?.status).toBe('error')
    expect(mapped[0]?.error?.message).toBe('locator not found')
  })
})

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
