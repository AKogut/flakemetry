import { describe, expect, it } from 'vitest'

import { disagreements, nightExecutions, testListFor } from '../lib/test-list.mjs'

const test = (title, overrides = {}) => ({
  filePath: 'tests/a.test.ts',
  suite: 'tests/a.test.ts',
  title,
  status: 'pass',
  durationMs: 12,
  error: null,
  ...overrides,
})

const key = (title) => `tests/a.test.ts > ${title}`

const logOf = (overrides = {}) => ({
  failed: new Map(),
  skipped: new Set(),
  named: new Set(),
  files: new Map([['tests/a.test.ts', { total: 2, failed: 0, skipped: 0 }]]),
  total: 2,
  ...overrides,
})

const oldTitles = { time: 100, tests: [test('old one'), test('old two')] }
const newTitles = { time: 300, tests: [test('new one'), test('new two')] }

describe('testListFor', () => {
  it('prefers the nearest artifact from before the run, even when a later one is closer', () => {
    const { tests } = testListFor([oldTitles, newTitles], 250, logOf())
    expect(tests).toBe(oldTitles.tests)
  })

  it('moves on when the log names a test the nearest artifact does not have', () => {
    const { tests, problems } = testListFor(
      [oldTitles, newTitles],
      250,
      logOf({ named: new Set([key('new one')]) }),
    )
    expect(tests).toBe(newTitles.tests)
    expect(problems).toEqual([])
  })

  it('uses a later artifact when nothing came before the run', () => {
    expect(testListFor([newTitles], 50, logOf()).tests).toBe(newTitles.tests)
  })

  it('keeps the nearest artifact and reports it when no artifact agrees', () => {
    const { tests, problems } = testListFor(
      [oldTitles, newTitles],
      250,
      logOf({ named: new Set([key('neither')]) }),
    )
    expect(tests).toBe(oldTitles.tests)
    expect(problems).toEqual([`named in the log, not in the list: ${key('neither')}`])
  })
})

describe('disagreements', () => {
  it('finds nothing when the list and the log match', () => {
    expect(disagreements(oldTitles.tests, logOf())).toEqual([])
  })

  it('compares the tests of each file, leaving out unit and contract tests', () => {
    const log = logOf({
      files: new Map([
        ['tests/a.test.ts', { total: 3, failed: 0, skipped: 0 }],
        ['tests/unit/b.test.ts', { total: 9, failed: 0, skipped: 0 }],
      ]),
      total: 12,
    })
    expect(disagreements(oldTitles.tests, log)).toEqual([
      'tests/a.test.ts: 3 in the log, 2 in the list',
    ])
  })

  it('notices a log whose files do not add up to its total', () => {
    expect(disagreements(oldTitles.tests, logOf({ total: 5 }))).toEqual([
      'the log counts 5 tests but its files add up to 2',
    ])
  })

  it('notices a failure or a skip the log counts but does not name', () => {
    const log = logOf({
      files: new Map([['tests/a.test.ts', { total: 2, failed: 1, skipped: 1 }]]),
    })
    expect(disagreements(oldTitles.tests, log)).toEqual([
      'tests/a.test.ts: 1 failed, 0 named as failed',
      'tests/a.test.ts: 1 skipped, 0 named as skipped',
    ])
  })

  it('ignores unit and contract tests named by the log', () => {
    const log = logOf({ named: new Set(['tests/pact/b.test.ts > x > y']) })
    expect(disagreements(oldTitles.tests, log)).toEqual([])
  })
})

describe('nightExecutions', () => {
  it('runs a test that was skipped locally, because the list includes it', () => {
    const [execution] = nightExecutions([test('guarded', { status: 'skip' })], logOf())
    expect(execution).toMatchObject({ title: 'guarded', status: 'pass', attempt: 1, durationMs: 0 })
  })

  it('takes failures and skips from the log and leaves the rest as passed', () => {
    const executions = nightExecutions(
      [test('red', { durationMs: 40 }), test('skipped'), test('green')],
      logOf({
        failed: new Map([[key('red'), 'expected 500 to be 200']]),
        skipped: new Set([key('skipped')]),
      }),
    )
    expect(executions.map(({ status }) => status)).toEqual(['fail', 'skip', 'pass'])
    expect(executions[0]).toMatchObject({
      durationMs: 0,
      error: { message: 'expected 500 to be 200' },
    })
    expect(executions[2].error).toBeNull()
  })

  it('keeps a failure the list does not have', () => {
    const executions = nightExecutions(
      [],
      logOf({ failed: new Map([['tests/b.test.ts > suite > gone', null]]) }),
    )
    expect(executions).toEqual([
      expect.objectContaining({
        filePath: 'tests/b.test.ts',
        title: 'suite > gone',
        status: 'fail',
        error: null,
      }),
    ])
  })
})
