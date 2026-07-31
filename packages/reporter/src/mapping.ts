import type { SpanKind, TestStatus } from '@flakemetry/contracts'
import type { RecordedStep } from '@flakemetry/sdk'
import type { TestStep } from '@playwright/test/reporter'

export type PlaywrightStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'

export const statusFromResult = (status: PlaywrightStatus, retry: number): TestStatus => {
  if (status === 'skipped') return 'skip'
  if (status === 'passed') return retry > 0 ? 'flaky' : 'pass'
  return 'fail'
}

export interface SuiteNode {
  type: string
  title: string
}

const spanKindFromCategory = (category: string): SpanKind => {
  if (category === 'test.step' || category === 'expect') return 'step'
  if (category === 'pw:api') return 'browser'
  return 'other'
}

export const mapSteps = (steps: readonly TestStep[]): RecordedStep[] => {
  const mapped: RecordedStep[] = []
  for (const step of steps) {
    if (step.category === 'attach') continue
    const children = mapSteps(step.steps ?? [])
    mapped.push({
      name: step.title,
      kind: spanKindFromCategory(step.category),
      startedAt: step.startTime,
      durationMs: Math.max(0, Math.round(step.duration)),
      status: step.error ? 'error' : 'ok',
      error: step.error
        ? {
            type: step.error.value ?? undefined,
            message: step.error.message ?? 'step error',
            stack: step.error.stack ?? undefined,
          }
        : null,
      ...(children.length > 0 ? { children } : {}),
    })
  }
  return mapped
}

export const deriveSuite = (ancestors: readonly SuiteNode[]): string =>
  ancestors
    .filter((node) => node.type === 'describe' && node.title.length > 0)
    .map((node) => node.title)
    .join(' > ')
