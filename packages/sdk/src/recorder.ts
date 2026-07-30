import {
  type ArtifactRef,
  type CiProvider,
  type IngestExecution,
  type IngestRunBatch,
  ingestRunBatchSchema,
  type IngestSpan,
  type JsonRecord,
  MAX_SPANS_PER_EXECUTION,
  type RunStatus,
  type RunTrigger,
  type SpanKind,
  type SpanStatus,
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
  shardIndex?: number | null
  shardTotal?: number | null
}

export interface RecordedStep {
  name: string
  kind: SpanKind
  startedAt: Date
  durationMs: number
  status?: SpanStatus
  error?: { type?: string | null; message: string; stack?: string | null } | null
  attributes?: JsonRecord | null
  children?: RecordedStep[]
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
  steps?: RecordedStep[] | null
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

  private flattenSteps(
    steps: readonly RecordedStep[],
    execIndex: number,
  ): { caseSpanId: string; spans: IngestSpan[] } {
    const caseSpanId = `x${execIndex}c`
    const spans: IngestSpan[] = []
    let counter = 0
    const walk = (nodes: readonly RecordedStep[], parentSpanId: string): void => {
      for (const node of nodes) {
        if (spans.length >= MAX_SPANS_PER_EXECUTION) return
        const spanId = `x${execIndex}s${counter++}`
        spans.push({
          spanId,
          parentSpanId,
          name: node.name,
          kind: node.kind,
          status: node.status ?? (node.error ? 'error' : 'ok'),
          startedAt: node.startedAt,
          durationMs: Math.round(node.durationMs),
          attributes: node.attributes ?? undefined,
          error: node.error ?? undefined,
        })
        if (node.children && node.children.length > 0) walk(node.children, spanId)
      }
    }
    walk(steps, caseSpanId)
    return { caseSpanId, spans }
  }

  private toExecution(test: RecordedTestWithIdentity, execIndex: number): IngestExecution {
    const tree =
      test.steps && test.steps.length > 0 ? this.flattenSteps(test.steps, execIndex) : null
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
      spanId: tree?.caseSpanId,
      spans: tree && tree.spans.length > 0 ? tree.spans : undefined,
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
        shardIndex: this.context.shardIndex ?? undefined,
        shardTotal: this.context.shardTotal ?? undefined,
      },
      run: {
        status: this.runStatus,
        startedAt,
        finishedAt: this.runFinishedAt ?? undefined,
      },
      executions: this.tests.map((test, index) => this.toExecution(test, index)),
    })
  }
}
