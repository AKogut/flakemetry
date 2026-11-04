import type { JsonRecord, TestStatus } from './common'
import type { JunitExecution, JunitRun } from './junit'

export interface AllureResult {
  name?: string
  fullName?: string
  historyId?: string
  testCaseId?: string
  status?: string
  statusDetails?: { message?: string; trace?: string } | null
  start?: number
  stop?: number
  labels?: { name: string; value: string }[]
  parameters?: { name: string; value: string; excluded?: boolean }[]
}

const labelOf = (result: AllureResult, name: string): string | undefined =>
  result.labels?.find((label) => label.name === name)?.value

const filePathOf = (result: AllureResult): string => {
  const [beforeHash, afterHash] = (result.fullName ?? '').split('#')
  if (beforeHash && afterHash !== undefined) return beforeHash
  const pkg = labelOf(result, 'package')
  if (pkg) return pkg.replace(/\./g, '/')
  return labelOf(result, 'suite') ?? labelOf(result, 'parentSuite') ?? 'unknown'
}

const suiteOf = (result: AllureResult): string =>
  labelOf(result, 'suite') ?? labelOf(result, 'parentSuite') ?? ''

const paramsOf = (result: AllureResult): JsonRecord | null => {
  const included = (result.parameters ?? []).filter((parameter) => !parameter.excluded)
  if (included.length === 0) return null
  return Object.fromEntries(included.map((parameter) => [parameter.name, parameter.value]))
}

const HOOK_SKIP_MESSAGE = /^Test skipped due to failure in hook\b/

const statusOf = (result: AllureResult, failedBefore: boolean): TestStatus => {
  if (result.status === 'passed') return failedBefore ? 'flaky' : 'pass'
  if (HOOK_SKIP_MESSAGE.test(result.statusDetails?.message ?? '')) return 'skip'
  if (result.status === 'failed' || result.status === 'broken') return 'fail'
  return 'skip'
}

const identityOf = (result: AllureResult): string =>
  result.historyId || result.testCaseId || result.fullName || result.name || ''

export const parseAllureResults = (results: readonly AllureResult[]): JunitRun => {
  const named = results.filter((result) => Boolean(result.name))
  const ordered = [...named].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))

  const attemptsByTest = new Map<string, AllureResult[]>()
  for (const result of ordered) {
    const key = identityOf(result)
    const attempts = attemptsByTest.get(key) ?? []
    attempts.push(result)
    attemptsByTest.set(key, attempts)
  }

  const executions: JunitExecution[] = []
  for (const attempts of attemptsByTest.values()) {
    const firstIndex = executions.length
    let failedBefore = false
    attempts.forEach((result, index) => {
      const status = statusOf(result, failedBefore)
      if (status === 'fail') failedBefore = true
      const message = result.statusDetails?.message
      executions.push({
        filePath: filePathOf(result),
        suite: suiteOf(result),
        title: result.name as string,
        params: paramsOf(result),
        status,
        attempt: index + 1,
        retryOfIndex: index > 0 ? firstIndex : null,
        startedAt: result.start == null ? null : new Date(result.start).toISOString(),
        durationMs:
          result.start != null && result.stop != null
            ? Math.max(0, Math.round(result.stop - result.start))
            : 0,
        error:
          status === 'fail'
            ? {
                type: null,
                message: message || 'test failed',
                stack: result.statusDetails?.trace ?? null,
              }
            : null,
      })
    })
  }

  const firstStart = ordered.find((result) => result.start != null)?.start
  return {
    startedAt: firstStart == null ? null : new Date(firstStart).toISOString(),
    executions,
  }
}
