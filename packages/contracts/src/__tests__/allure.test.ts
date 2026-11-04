import { describe, expect, it } from 'vitest'

import { type AllureResult, parseAllureResults } from '../allure'

const result = (overrides: Partial<AllureResult> = {}): AllureResult => ({
  name: 'TC-TASK-021 — Edit task title and save',
  fullName: 'src/tests/tasks/task-edit.spec.ts#Tasks — Edit.TC-TASK-021 — Edit task title and save',
  historyId: '607d42d2c06b361cc7ab26d1987648ea',
  status: 'passed',
  statusDetails: {},
  start: 1793703898645,
  stop: 1793703966803,
  labels: [
    { name: 'parentSuite', value: 'Tasks — Edit' },
    { name: 'package', value: 'src.tests.tasks.task-edit.spec.ts' },
    { name: 'framework', value: 'wdio' },
  ],
  parameters: [],
  ...overrides,
})

describe('parseAllureResults', () => {
  it('maps one passing result the way WebdriverIO writes it', () => {
    const run = parseAllureResults([result()])

    expect(run.startedAt).toBe(new Date(1793703898645).toISOString())
    expect(run.executions).toEqual([
      expect.objectContaining({
        filePath: 'src/tests/tasks/task-edit.spec.ts',
        suite: 'Tasks — Edit',
        title: 'TC-TASK-021 — Edit task title and save',
        status: 'pass',
        attempt: 1,
        retryOfIndex: null,
        durationMs: 68158,
      }),
    ])
  })

  it('records a test that failed and then passed as a flaky retry of the same test', () => {
    const run = parseAllureResults([
      result({ status: 'passed', start: 2000, stop: 2500, statusDetails: {} }),
      result({ status: 'failed', start: 1000, stop: 1500, statusDetails: { message: 'boom' } }),
    ])

    expect(run.executions.map((execution) => [execution.attempt, execution.status])).toEqual([
      [1, 'fail'],
      [2, 'flaky'],
    ])
    expect(run.executions[1]?.retryOfIndex).toBe(0)
    expect(run.executions[0]?.error?.message).toBe('boom')
  })

  it('points every retry at the first attempt of its own test', () => {
    const other = { historyId: 'other', name: 'other', fullName: 'other.spec.ts#s.other' }
    const run = parseAllureResults([
      result({ start: 1, status: 'failed' }),
      result({ ...other, start: 2 }),
      result({ start: 3, status: 'failed' }),
      result({ start: 4, status: 'passed' }),
    ])

    const retries = run.executions.filter((execution) => (execution.attempt ?? 1) > 1)
    expect(retries.map((retry) => retry.retryOfIndex)).toEqual([0, 0])
    expect(run.executions[run.executions.length - 1]?.title).toBe('other')
  })

  it('counts broken as failed and anything unknown as skipped', () => {
    const run = parseAllureResults([
      result({ historyId: 'a', status: 'broken' }),
      result({ historyId: 'b', status: 'skipped' }),
      result({ historyId: 'c', status: 'unknown' }),
    ])
    expect(run.executions.map((execution) => execution.status)).toEqual(['fail', 'skip', 'skip'])
  })

  it('keeps parameters, leaving out the ones Allure marks as excluded', () => {
    const [execution] = parseAllureResults([
      result({
        parameters: [
          { name: 'browser', value: 'chrome' },
          { name: 'seed', value: '7', excluded: true },
        ],
      }),
    ]).executions
    expect(execution?.params).toEqual({ browser: 'chrome' })
  })

  it('derives a path from the package label when there is no full name', () => {
    const [execution] = parseAllureResults([result({ fullName: undefined })]).executions
    expect(execution?.filePath).toBe('src/tests/tasks/task-edit/spec/ts')
  })

  it('ignores a result with no name rather than inventing a test', () => {
    expect(parseAllureResults([result({ name: undefined })]).executions).toEqual([])
  })
})
