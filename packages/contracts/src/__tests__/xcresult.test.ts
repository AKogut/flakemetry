import { describe, expect, it } from 'vitest'

import { parseXcresultTests, type XcresultNode } from '../xcresult'

const tree = (...testCases: XcresultNode[]) => ({
  testNodes: [
    {
      nodeType: 'Test Plan',
      name: 'MobileTaskManager',
      children: [
        {
          nodeType: 'UI test bundle',
          name: 'MobileTaskManagerUITests',
          children: [{ nodeType: 'Test Suite', name: 'AuthFlowUITests', children: testCases }],
        },
      ],
    },
  ],
})

describe('parseXcresultTests', () => {
  it('maps a test that passed first time', () => {
    const run = parseXcresultTests(
      tree({
        nodeType: 'Test Case',
        name: 'test_TC_AUTH_001_validLogin()',
        result: 'Passed',
        durationInSeconds: 55.803,
        children: [{ nodeType: 'Runtime Warning', name: 'ignored' }],
      }),
    )

    expect(run.startedAt).toBeNull()
    expect(run.executions).toEqual([
      expect.objectContaining({
        filePath: 'MobileTaskManagerUITests/AuthFlowUITests',
        suite: 'AuthFlowUITests',
        title: 'test_TC_AUTH_001_validLogin',
        status: 'pass',
        attempt: 1,
        retryOfIndex: null,
        durationMs: 55803,
      }),
    ])
  })

  it('reads repetitions as attempts, so a retried pass is flaky', () => {
    const run = parseXcresultTests(
      tree({
        nodeType: 'Test Case',
        name: 'test_TC_TASK_018()',
        result: 'Passed',
        children: [
          {
            nodeType: 'Repetition',
            name: 'First Run',
            result: 'Failed',
            durationInSeconds: 1,
            children: [{ nodeType: 'Failure Message', name: 'expected the task to be gone' }],
          },
          { nodeType: 'Repetition', name: 'Retry 1', result: 'Passed', durationInSeconds: 2 },
        ],
      }),
    )

    expect(run.executions.map((execution) => [execution.attempt, execution.status])).toEqual([
      [1, 'fail'],
      [2, 'flaky'],
    ])
    expect(run.executions[0]?.error?.message).toBe('expected the task to be gone')
    expect(run.executions[1]?.retryOfIndex).toBe(0)
  })

  it('finds repetitions nested under a device', () => {
    const run = parseXcresultTests(
      tree({
        nodeType: 'Test Case',
        name: 'test_x()',
        result: 'Failed',
        children: [
          {
            nodeType: 'Device',
            name: 'iPhone',
            children: [
              { nodeType: 'Repetition', name: 'First Run', result: 'Failed' },
              { nodeType: 'Repetition', name: 'Retry 1', result: 'Failed' },
            ],
          },
        ],
      }),
    )
    expect(run.executions.map((execution) => execution.status)).toEqual(['fail', 'fail'])
  })

  it('treats a skipped test and an expected failure as what they are', () => {
    const run = parseXcresultTests(
      tree(
        { nodeType: 'Test Case', name: 'a()', result: 'Skipped' },
        { nodeType: 'Test Case', name: 'b()', result: 'Expected Failure' },
      ),
    )
    expect(run.executions.map((execution) => execution.status)).toEqual(['skip', 'pass'])
  })

  it('returns nothing for an empty document', () => {
    expect(parseXcresultTests({}).executions).toEqual([])
  })
})
