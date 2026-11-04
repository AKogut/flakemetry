import type { TestStatus } from './common'
import type { JunitExecution, JunitRun } from './junit'

export interface XcresultNode {
  nodeType?: string
  name?: string
  result?: string
  durationInSeconds?: number
  children?: XcresultNode[]
}

export interface XcresultTests {
  testNodes?: XcresultNode[]
}

const descendants = (node: XcresultNode, nodeType: string): XcresultNode[] =>
  (node.children ?? []).flatMap((child) =>
    child.nodeType === nodeType ? [child] : descendants(child, nodeType),
  )

const statusOf = (result: string | undefined, failedBefore: boolean): TestStatus => {
  if (result === 'Passed' || result === 'Expected Failure') return failedBefore ? 'flaky' : 'pass'
  if (result === 'Failed') return 'fail'
  return 'skip'
}

const durationOf = (node: XcresultNode): number =>
  Math.max(0, Math.round((node.durationInSeconds ?? 0) * 1000))

const testCaseExecutions = (
  testCase: XcresultNode,
  bundle: string,
  suite: string,
  firstIndex: number,
): JunitExecution[] => {
  const repetitions = descendants(testCase, 'Repetition')
  const attempts = repetitions.length > 0 ? repetitions : [testCase]
  const title = (testCase.name ?? 'unknown test').replace(/\(\)$/, '')
  let failedBefore = false

  return attempts.map((attempt, index) => {
    const status = statusOf(attempt.result, failedBefore)
    if (status === 'fail') failedBefore = true
    const message = descendants(attempt, 'Failure Message')[0]?.name
    return {
      filePath: [bundle, suite].filter(Boolean).join('/') || title,
      suite,
      title,
      status,
      attempt: index + 1,
      retryOfIndex: index > 0 ? firstIndex : null,
      durationMs: durationOf(attempt),
      error:
        status === 'fail' ? { type: null, message: message || 'test failed', stack: null } : null,
    }
  })
}

export const parseXcresultTests = (tests: XcresultTests): JunitRun => {
  const executions: JunitExecution[] = []

  const walk = (nodes: readonly XcresultNode[], bundle: string, suite: string): void => {
    for (const node of nodes) {
      if (node.nodeType === 'Test Case') {
        executions.push(...testCaseExecutions(node, bundle, suite, executions.length))
        continue
      }
      const isBundle = node.nodeType === 'UI test bundle' || node.nodeType === 'Unit test bundle'
      walk(
        node.children ?? [],
        isBundle ? (node.name ?? bundle) : bundle,
        node.nodeType === 'Test Suite' ? (node.name ?? suite) : suite,
      )
    }
  }

  walk(tests.testNodes ?? [], '', '')
  return { startedAt: null, executions }
}
