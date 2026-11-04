import { describe, expect, it } from 'vitest'

import {
  espressoExecutions,
  parseAppiumLog,
  parseEspressoLog,
  parseVitestLog,
  parseXcuitestLog,
} from '../lib/logs.mjs'

const stamped = (lines) => lines.map((line) => `2026-09-12T07:56:43.1234567Z ${line}`).join('\n')

describe('parseXcuitestLog', () => {
  const bundle = 'MobileTaskManagerUITests.TaskCreationUITests'
  const test = 'test_TC_TASK_001_createTaskWithAllFields'

  it('reads every iteration of a retried test as an attempt', () => {
    const executions = parseXcuitestLog(
      stamped([
        `Test Case '-[${bundle} ${test}]' started (Iteration 1 of 3).`,
        `/x/TaskCreationUITests.swift:36: error: -[${bundle} ${test}] : XCTAssertTrue failed`,
        `Test Case '-[${bundle} ${test}]' failed (111.228 seconds).`,
        `Test Case '-[${bundle} ${test}]' started (Iteration 2 of 3).`,
        `Test Case '-[${bundle} ${test}]' passed (55.803 seconds).`,
      ]),
    )

    expect(executions).toEqual([
      expect.objectContaining({
        filePath: 'MobileTaskManagerUITests/TaskCreationUITests',
        suite: 'TaskCreationUITests',
        title: test,
        status: 'fail',
        attempt: 1,
        durationMs: 111228,
        error: expect.objectContaining({ message: 'XCTAssertTrue failed' }),
      }),
      expect.objectContaining({ status: 'flaky', attempt: 2, retryOfIndex: 0, durationMs: 55803 }),
    ])
  })

  it('keeps a first-time pass as a plain pass', () => {
    const [execution] = parseXcuitestLog(
      stamped([`Test Case '-[${bundle} ${test}]' passed (1.000 seconds).`]),
    )
    expect(execution.status).toBe('pass')
  })
})

describe('parseAppiumLog', () => {
  const failure =
    '[app-release.apk Android #0-0]    ✖ TC-AUTH-002 — Login fails » [ /src/tests/auth/auth.negative.spec.ts ]'
  const pass =
    '[app-release.apk Android #0-0]    ✓ TC-AUTH-002 — Login fails » [ /src/tests/auth/auth.negative.spec.ts ]'

  it('reads real-time result lines as attempts and takes the suite from the error', () => {
    const executions = parseAppiumLog(
      stamped([
        '[0-0] Error in "Authentication — Negative.TC-AUTH-002 — Login fails"',
        'Error: waitUntil condition timed out after 10000ms',
        failure,
        pass,
      ]),
    )

    expect(executions).toEqual([
      expect.objectContaining({
        filePath: 'src/tests/auth/auth.negative.spec.ts',
        suite: 'Authentication — Negative',
        title: 'TC-AUTH-002 — Login fails',
        status: 'fail',
        attempt: 1,
        error: expect.objectContaining({
          message: 'waitUntil condition timed out after 10000ms',
        }),
      }),
      expect.objectContaining({ status: 'flaky', attempt: 2 }),
    ])
  })

  it('ignores the summary lines, which would double-count every attempt', () => {
    const executions = parseAppiumLog(
      stamped([pass, '[app-release.apk Android #0-0]    ✓ TC-AUTH-002 — Login fails (1x retries)']),
    )
    expect(executions).toHaveLength(1)
  })

  it('uses a known suite when the test never failed', () => {
    const [execution] = parseAppiumLog(
      stamped([pass]),
      new Map([['TC-AUTH-002 — Login fails', 'Authentication — Negative']]),
    )
    expect(execution.suite).toBe('Authentication — Negative')
  })

  it('finds nothing in a session failure, so the night counts as no tests ran', () => {
    expect(
      parseAppiumLog(stamped(['[iPhone 16 Pro iOS 18.5 #0-0] ✖ Failed to create a session:'])),
    ).toEqual([])
  })
})

describe('parseEspressoLog', () => {
  it('reads failures and whether the suite finished', () => {
    const { failed, finished } = parseEspressoLog(
      stamped([
        'com.mobiletaskmanager.TaskDeletionTest > TC_TASK_018_confirmingDeleteRemovesTask[emulator-5554 - 15] FAILED ',
        'Test instrumentation process crashed. Check the log.',
        'Finished 49 tests on emulator-5554 - 15',
      ]),
    )
    expect([...failed]).toEqual([
      [
        'TC_TASK_018_confirmingDeleteRemovesTask',
        'Test instrumentation process crashed. Check the log.',
      ],
    ])
    expect(finished).toBe(49)
  })

  it('applies failures to the known tests', () => {
    const universe = [
      { filePath: 'a', suite: 'a', title: 'one', durationMs: 1 },
      { filePath: 'a', suite: 'a', title: 'two', durationMs: 1 },
    ]
    const executions = espressoExecutions(universe, new Map([['two', 'it crashed']]))
    expect(executions.map((execution) => execution.status)).toEqual(['pass', 'fail'])
    expect(executions[1].error.message).toBe('it crashed')
  })
})

describe('parseVitestLog', () => {
  it('reads failed tests', () => {
    const { failed, stoppedAtGate } = parseVitestLog(
      stamped([
        ' FAIL  tests/smoke/rooms.test.ts > room service @smoke > returns a created room by id',
        'AssertionError: expected 500 to be 200',
      ]),
    )
    expect([...failed]).toEqual([
      [
        'tests/smoke/rooms.test.ts > room service @smoke > returns a created room by id',
        'AssertionError: expected 500 to be 200',
      ],
    ])
    expect(stoppedAtGate).toBe(false)
  })

  it('recognises the readiness gate and the local fallback', () => {
    expect(
      parseVitestLog(stamped(['Restful Booker Platform is not ready after 29 attempts']))
        .stoppedAtGate,
    ).toBe(true)
    expect(
      parseVitestLog(stamped(['The hosted platform failed its health checks, so this report']))
        .usedLocalTarget,
    ).toBe(true)
  })
})

describe('the file results of a vitest log', () => {
  const FLAT = stamped([
    ' ❯ tests/smoke/bookings.test.ts (11 tests | 1 failed) 6602ms',
    '   ✓ booking service @smoke > creates a booking 186ms',
    '   × booking service @smoke > returns a booking by id 337ms',
    '     → expected 403 to be 200 // Object.is equality',
    'If this is a long-running test, pass a timeout value',
    '   ✓ booking service @smoke > rejects a deletion  412ms',
    ' ❯ tests/data-driven/bookings.data.test.ts (8 tests | 8 skipped) 322ms',
    '   ↓ booking creation dataset @data-driven > booking case: deposit not paid',
    ' ✓ tests/unit/config.test.ts (11 tests) 10ms',
    '  Test Files  1 failed | 2 passed (3)',
    '       Tests  1 failed | 21 passed | 8 skipped (30)',
    ' ❯ tests/smoke/bookings.test.ts:103:29',
    '   ✓ not a test line',
  ])

  const TREE = stamped([
    ' ❯ tests/security/authorization.security.test.ts (17 tests | 1 failed) 6807ms',
    '   ❯ function-level authorization (BFLA) @security (15)',
    '     ✓ denies room.create to an anonymous caller 311ms',
    '     × denies booking.delete to an anonymous caller 325ms',
    '   ✓ object-level authorization (IDOR) @security (2)',
    '     ✓ does not serve a booking by id (BUG-001) 128ms',
    ' ✓ tests/property/room.property.test.ts (1 test) 4593ms',
    '  Test Files  1 failed | 1 passed (2)',
    '       Tests  1 failed | 17 passed (18)',
  ])

  it('counts each file, with its failures and skips', () => {
    const { files, total } = parseVitestLog(FLAT)
    expect([...files]).toEqual([
      ['tests/smoke/bookings.test.ts', { total: 11, failed: 1, skipped: 0 }],
      ['tests/data-driven/bookings.data.test.ts', { total: 8, failed: 0, skipped: 8 }],
      ['tests/unit/config.test.ts', { total: 11, failed: 0, skipped: 0 }],
    ])
    expect(total).toBe(30)
  })

  it('reads the flat format of older runs, without what follows the file results', () => {
    const { named, skipped } = parseVitestLog(FLAT)
    expect([...named]).toEqual([
      'tests/smoke/bookings.test.ts > booking service @smoke > creates a booking',
      'tests/smoke/bookings.test.ts > booking service @smoke > returns a booking by id',
      'tests/smoke/bookings.test.ts > booking service @smoke > rejects a deletion',
      'tests/data-driven/bookings.data.test.ts > booking creation dataset @data-driven > booking case: deposit not paid',
    ])
    expect([...skipped]).toEqual([
      'tests/data-driven/bookings.data.test.ts > booking creation dataset @data-driven > booking case: deposit not paid',
    ])
  })

  it('reads the tree format of newer runs into the same names', () => {
    const { named, files, total } = parseVitestLog(TREE)
    expect([...named]).toEqual([
      'tests/security/authorization.security.test.ts > function-level authorization (BFLA) @security > denies room.create to an anonymous caller',
      'tests/security/authorization.security.test.ts > function-level authorization (BFLA) @security > denies booking.delete to an anonymous caller',
      'tests/security/authorization.security.test.ts > object-level authorization (IDOR) @security > does not serve a booking by id (BUG-001)',
    ])
    expect(files.get('tests/property/room.property.test.ts')).toEqual({
      total: 1,
      failed: 0,
      skipped: 0,
    })
    expect(total).toBe(18)
  })

  it('has no total when the suite never ran', () => {
    const { total, files } = parseVitestLog(
      stamped(['Restful Booker Platform is not ready after 29 attempts']),
    )
    expect(total).toBeNull()
    expect(files.size).toBe(0)
  })
})

describe('several failures sharing one error', () => {
  it('gives each of them that error, not the next failure line', () => {
    const { failed } = parseVitestLog(
      stamped([
        ' FAIL  tests/a.test.ts > suite > first',
        ' FAIL  tests/a.test.ts > suite > second',
        'AssertionError: expected 500 to be 200',
      ]),
    )
    expect([...failed.values()]).toEqual([
      'AssertionError: expected 500 to be 200',
      'AssertionError: expected 500 to be 200',
    ])
  })
})

describe('a failure whose log says nothing about why', () => {
  it('records no error rather than inventing one', () => {
    const { failed } = parseVitestLog(' FAIL  tests/a.test.ts > suite > test')
    const universe = [{ filePath: 'a', suite: 'a', title: 'test', durationMs: 1 }]

    expect([...failed.values()]).toEqual([null])
    expect(espressoExecutions(universe, new Map([['test', null]]))[0].error).toBeNull()
  })
})
