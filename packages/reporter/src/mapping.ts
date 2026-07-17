import { randomUUID } from 'node:crypto'

import type { CiProvider, RunTrigger, TestStatus } from '@flakemetry/contracts'
import type { RunContext } from '@flakemetry/sdk'

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

export const deriveSuite = (ancestors: readonly SuiteNode[]): string =>
  ancestors
    .filter((node) => node.type === 'describe' && node.title.length > 0)
    .map((node) => node.title)
    .join(' > ')

const prNumberFromRef = (ref: string | undefined): number | null => {
  if (!ref) return null
  const match = /refs\/pull\/(\d+)\//.exec(ref)
  return match ? Number(match[1]) : null
}

const pick = (value: string | undefined): string | undefined =>
  value && value.length > 0 ? value : undefined

export const resolveRunContext = (env: Record<string, string | undefined>): RunContext => {
  const onGithub = env.GITHUB_ACTIONS === 'true'
  const ciProvider: CiProvider = onGithub ? 'github_actions' : 'local'
  const trigger: RunTrigger = onGithub
    ? env.GITHUB_EVENT_NAME === 'pull_request'
      ? 'pull_request'
      : env.GITHUB_EVENT_NAME === 'schedule'
        ? 'schedule'
        : 'push'
    : 'manual'

  return {
    project: pick(env.FLAKEMETRY_PROJECT) ?? 'local/project',
    commitSha: pick(env.GITHUB_SHA) ?? pick(env.FLAKEMETRY_COMMIT_SHA) ?? '0000000',
    branch: pick(env.GITHUB_REF_NAME) ?? pick(env.FLAKEMETRY_BRANCH) ?? 'local',
    ciProvider,
    trigger,
    ciRunId: pick(env.GITHUB_RUN_ID) ?? null,
    prNumber: prNumberFromRef(pick(env.GITHUB_REF)),
  }
}

export const buildIdempotencyKey = (
  context: RunContext,
  env: Record<string, string | undefined>,
): string => {
  const explicit = env.FLAKEMETRY_IDEMPOTENCY_KEY
  if (explicit) return explicit
  if (context.ciRunId)
    return `${context.ciProvider}-${context.ciRunId}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`
  return `local-${randomUUID()}`
}
