import type { TestStatus } from '@flakemetry/contracts'
import type { RecordedTest } from '@flakemetry/sdk'

export interface JestAssertionResult {
  title: string
  ancestorTitles?: string[]
  status: string
  duration?: number | null
  failureMessages?: string[]
  retryReasons?: string[]
}

export interface JestFileResult {
  testFilePath: string
  testResults: JestAssertionResult[]
}

export interface JestAggregatedResult {
  startTime?: number
  testResults: JestFileResult[]
}

const statusFromJest = (status: string, retries: number): TestStatus => {
  if (status === 'failed') return 'fail'
  if (status === 'passed' || status === 'focused') return retries > 0 ? 'flaky' : 'pass'
  return 'skip'
}

const ANSI = /\[[0-9;]*m/g
const STACK_FRAME = /^\s*at\s/
const MAX_MESSAGE_LENGTH = 1000

/**
 * Playwright and Vitest hand the reporter a structured error whose `message` already
 * carries the expected and received values. Jest hands over a rendered string instead,
 * whose first line is only the matcher header — "expect(received).toBe(expected)" — which
 * is byte-identical for every `toBe` failure in a project. Keeping just that line collapsed
 * every assertion failure onto one error signature, so clustering grouped unrelated tests
 * and root-cause analysis was handed a prompt with no actual values in it.
 *
 * Everything up to the first stack frame is the part Jest wrote for a human to read.
 */
const summarizeFailure = (failure: string): string => {
  const lines = failure.replace(ANSI, '').split('\n')
  const frame = lines.findIndex((line) => STACK_FRAME.test(line))
  const summary = (frame === -1 ? lines : lines.slice(0, frame))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
  return summary.length > 0 ? summary.slice(0, MAX_MESSAGE_LENGTH) : 'test failed'
}

const relativize = (rootDir: string, filePath: string): string => {
  if (rootDir && filePath.startsWith(rootDir)) {
    return filePath.slice(rootDir.length).replace(/^[/\\]+/, '')
  }
  return filePath
}

export const mapJestResults = (
  results: JestAggregatedResult,
  rootDir: string,
  fallbackStart: Date,
): RecordedTest[] => {
  const out: RecordedTest[] = []
  for (const file of results.testResults ?? []) {
    const filePath = relativize(rootDir, file.testFilePath)
    for (const assertion of file.testResults ?? []) {
      const retries = assertion.retryReasons?.length ?? 0
      const status = statusFromJest(assertion.status, retries)
      const failure = assertion.failureMessages?.[0]
      out.push({
        filePath,
        suite: (assertion.ancestorTitles ?? []).filter((title) => title.length > 0).join(' > '),
        title: assertion.title,
        status,
        attempt: 1,
        retryOfIndex: null,
        startedAt: fallbackStart,
        durationMs: Math.max(0, Math.round(assertion.duration ?? 0)),
        error:
          status === 'fail' && failure
            ? { type: null, message: summarizeFailure(failure), stack: failure.replace(ANSI, '') }
            : null,
      })
    }
  }
  return out
}
