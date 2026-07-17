export const SPAN_NAMES = {
  run: 'test.run',
  case: 'test.case',
  step: 'test.step',
} as const

export const RESOURCE_ATTR = {
  serviceName: 'service.name',
  project: 'flakemetry.project',
  ciProvider: 'ci.provider',
  ciRunId: 'ci.run_id',
  commitSha: 'vcs.commit_sha',
  branch: 'vcs.branch',
  prNumber: 'vcs.pr_number',
} as const

export const SPAN_ATTR = {
  fingerprint: 'test.identity.fingerprint',
  suite: 'test.suite',
  title: 'test.title',
  paramsHash: 'test.params_hash',
  status: 'test.status',
  attempt: 'test.attempt',
  retryOf: 'test.retry_of',
  filePath: 'test.file_path',
  durationMs: 'test.duration_ms',
} as const

export const CONVENTIONS_VERSION = '0.1.0'

export type ResourceAttributeKey = (typeof RESOURCE_ATTR)[keyof typeof RESOURCE_ATTR]
export type SpanAttributeKey = (typeof SPAN_ATTR)[keyof typeof SPAN_ATTR]
