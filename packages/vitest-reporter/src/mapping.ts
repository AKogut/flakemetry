import type { TestStatus } from '@flakemetry/contracts'
import type { RecordedTest } from '@flakemetry/sdk'

export interface VitestTaskError {
  name?: string
  message?: string
  stack?: string
}

export interface VitestTaskResult {
  state?: string
  duration?: number
  startTime?: number
  retryCount?: number
  errors?: VitestTaskError[]
}

export interface VitestTask {
  type?: string
  name: string
  mode?: string
  result?: VitestTaskResult
  tasks?: VitestTask[]
}

export interface VitestFile extends VitestTask {
  filepath?: string
}

const statusFromState = (state: string | undefined, retryCount: number): TestStatus => {
  if (state === 'skip' || state === 'todo') return 'skip'
  if (state === 'fail') return 'fail'
  if (state === 'pass') return retryCount > 0 ? 'flaky' : 'pass'
  return 'skip'
}

const relativize = (rootDir: string, filePath: string): string => {
  if (rootDir && filePath.startsWith(rootDir)) {
    return filePath.slice(rootDir.length).replace(/^[/\\]+/, '')
  }
  return filePath
}

export const mapVitestFiles = (
  files: readonly VitestFile[],
  rootDir: string,
  fallbackStart: Date,
): RecordedTest[] => {
  const out: RecordedTest[] = []

  const walk = (tasks: readonly VitestTask[], suite: string[], filePath: string): void => {
    for (const task of tasks) {
      if (task.type === 'suite') {
        walk(task.tasks ?? [], task.name ? [...suite, task.name] : suite, filePath)
        continue
      }
      const result = task.result ?? {}
      const retryCount = result.retryCount ?? 0
      const status = statusFromState(result.state, retryCount)
      const firstError = result.errors?.[0]
      out.push({
        filePath,
        suite: suite.join(' > '),
        title: task.name,
        status,
        attempt: 1,
        retryOfIndex: null,
        startedAt: result.startTime != null ? new Date(result.startTime) : fallbackStart,
        durationMs: Math.max(0, Math.round(result.duration ?? 0)),
        error:
          status === 'fail' && firstError
            ? {
                type: firstError.name ?? null,
                message: firstError.message ?? 'test failed',
                stack: firstError.stack ?? null,
              }
            : null,
      })
    }
  }

  for (const file of files) {
    walk(file.tasks ?? [], [], relativize(rootDir, file.filepath ?? ''))
  }
  return out
}
