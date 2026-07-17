import {
  type ArtifactRef,
  type CiProvider,
  type IngestExecution,
  type IngestRunBatch,
  ingestRunBatchSchema,
  type JsonRecord,
  type RunStatus,
  type RunTrigger,
  type TestStatus,
} from '@flakemetry/contracts'

import { CONVENTIONS_VERSION } from './conventions'
import { computeFingerprint, hashParams } from './fingerprint'

export interface RunContext {
  project: string
  commitSha: string
  branch: string
  ciProvider: CiProvider
  trigger: RunTrigger
  ciRunId?: string | null
  prNumber?: number | null
}

export interface RecordedTest {
  filePath: string
  suite: string
  title: string
  params?: JsonRecord | null
  status: TestStatus
  attempt?: number
  retryOfIndex?: number | null
  startedAt: Date
  durationMs: number
  error?: { type?: string | null; message: string; stack?: string | null } | null
  artifacts?: ArtifactRef[] | null
  attributes?: JsonRecord | null
}

export interface RecordedTestWithIdentity extends RecordedTest {
  fingerprint: string
  paramsHash: string | null
}

export class TestRunRecorder {
  private readonly tests: RecordedTestWithIdentity[] = []
  private runStartedAt: Date | null = null
  private runFinishedAt: Date | null = null
  private runStatus: RunStatus = 'running'

  constructor(readonly context: RunContext) {}

  startRun(startedAt: Date): void {
    this.runStartedAt = startedAt
  }

  record(test: RecordedTest): RecordedTestWithIdentity {
    const paramsHash = hashParams(test.params)
    const fingerprint = computeFingerprint({
      filePath: test.filePath,
      suite: test.suite,
      title: test.title,
      paramsHash,
    })
    const enriched: RecordedTestWithIdentity = { ...test, fingerprint, paramsHash }
    this.tests.push(enriched)
    return enriched
  }

  finishRun(status: RunStatus, finishedAt: Date): void {
    this.runStatus = status
    this.runFinishedAt = finishedAt
  }

  get recorded(): readonly RecordedTestWithIdentity[] {
    return this.tests
  }

  private toExecution(test: RecordedTestWithIdentity): IngestExecution {
    return {
      filePath: test.filePath,
      suite: test.suite,
      title: test.title,
      params: test.params ?? undefined,
      status: test.status,
      attempt: test.attempt ?? 1,
      retryOfIndex: test.retryOfIndex ?? undefined,
      startedAt: test.startedAt,
      durationMs: test.durationMs,
      error: test.error ?? undefined,
      artifacts: test.artifacts ?? undefined,
      attributes: test.attributes ?? undefined,
    }
  }

  toIngestBatch(idempotencyKey: string): IngestRunBatch {
    const startedAt = this.runStartedAt ?? this.tests[0]?.startedAt ?? new Date(0)
    return ingestRunBatchSchema.parse({
      contractVersion: CONVENTIONS_VERSION,
      idempotencyKey,
      resource: {
        ciProvider: this.context.ciProvider,
        ciRunId: this.context.ciRunId ?? undefined,
        commitSha: this.context.commitSha,
        branch: this.context.branch,
        prNumber: this.context.prNumber ?? undefined,
        trigger: this.context.trigger,
      },
      run: {
        status: this.runStatus,
        startedAt,
        finishedAt: this.runFinishedAt ?? undefined,
      },
      executions: this.tests.map((test) => this.toExecution(test)),
    })
  }
}
