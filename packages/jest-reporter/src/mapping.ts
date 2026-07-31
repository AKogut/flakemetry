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
            ? { type: null, message: failure.split('\n')[0] ?? 'test failed', stack: failure }
            : null,
      })
    }
  }
  return out
}
