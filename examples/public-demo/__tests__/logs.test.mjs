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
        'Finished 49 tests on emulator-5554 - 15',
      ]),
    )
    expect([...failed]).toEqual(['TC_TASK_018_confirmingDeleteRemovesTask'])
    expect(finished).toBe(49)
  })

  it('applies failures to the known tests', () => {
    const universe = [
      { filePath: 'a', suite: 'a', title: 'one', durationMs: 1 },
      { filePath: 'a', suite: 'a', title: 'two', durationMs: 1 },
    ]
    const executions = espressoExecutions(universe, new Set(['two']))
    expect(executions.map((execution) => execution.status)).toEqual(['pass', 'fail'])
  })
})

describe('parseVitestLog', () => {
  it('reads failed tests', () => {
    const { failed, stoppedAtGate } = parseVitestLog(
      stamped([
        ' FAIL  tests/smoke/rooms.test.ts > room service @smoke > returns a created room by id',
      ]),
    )
    expect([...failed]).toEqual([
      'tests/smoke/rooms.test.ts > room service @smoke > returns a created room by id',
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
