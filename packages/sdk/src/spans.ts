import { context, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api'

import { CONVENTIONS_VERSION, RESOURCE_ATTR, SPAN_ATTR, SPAN_NAMES } from './conventions'
import type { TestRunRecorder } from './recorder'

const spanStatusFor = (status: string): SpanStatusCode => {
  if (status === 'fail') return SpanStatusCode.ERROR
  if (status === 'skip') return SpanStatusCode.UNSET
  return SpanStatusCode.OK
}

export interface EmitRunSpansOptions {
  idempotencyKey?: string
}

export const emitRunSpans = (
  tracer: Tracer,
  recorder: TestRunRecorder,
  options: EmitRunSpansOptions = {},
): void => {
  const { context: runContext, recorded } = recorder
  const runStart = recorded[0]?.startedAt ?? new Date()

  const runSpan = tracer.startSpan(SPAN_NAMES.run, {
    startTime: runStart,
    attributes: {
      [RESOURCE_ATTR.project]: runContext.project,
      [RESOURCE_ATTR.commitSha]: runContext.commitSha,
      [RESOURCE_ATTR.branch]: runContext.branch,
      [RESOURCE_ATTR.ciProvider]: runContext.ciProvider,
      [RESOURCE_ATTR.trigger]: runContext.trigger,
      [RESOURCE_ATTR.contractVersion]: CONVENTIONS_VERSION,
      ...(options.idempotencyKey ? { [RESOURCE_ATTR.idempotencyKey]: options.idempotencyKey } : {}),
      ...(runContext.ciRunId ? { [RESOURCE_ATTR.ciRunId]: runContext.ciRunId } : {}),
      ...(runContext.prNumber ? { [RESOURCE_ATTR.prNumber]: runContext.prNumber } : {}),
    },
  })

  const runCtx = trace.setSpan(context.active(), runSpan)
  let lastEnd = runStart.getTime()

  for (const test of recorded) {
    const endTime = new Date(test.startedAt.getTime() + test.durationMs)
    lastEnd = Math.max(lastEnd, endTime.getTime())

    const caseSpan = tracer.startSpan(
      SPAN_NAMES.case,
      {
        startTime: test.startedAt,
        attributes: {
          [SPAN_ATTR.fingerprint]: test.fingerprint,
          [SPAN_ATTR.suite]: test.suite,
          [SPAN_ATTR.title]: test.title,
          [SPAN_ATTR.filePath]: test.filePath,
          [SPAN_ATTR.status]: test.status,
          [SPAN_ATTR.attempt]: test.attempt ?? 1,
          [SPAN_ATTR.durationMs]: test.durationMs,
          ...(test.paramsHash ? { [SPAN_ATTR.paramsHash]: test.paramsHash } : {}),
        },
      },
      runCtx,
    )

    if (test.error) {
      caseSpan.recordException({
        name: test.error.type ?? 'Error',
        message: test.error.message,
        stack: test.error.stack ?? undefined,
      })
    }
    caseSpan.setStatus({ code: spanStatusFor(test.status) })
    caseSpan.end(endTime)
  }

  runSpan.setStatus({
    code: recorded.some((t) => t.status === 'fail') ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  })
  runSpan.end(new Date(lastEnd))
}
