import { z } from 'zod'

import {
  type CiProvider,
  CONTRACT_VERSION,
  type RunStatus,
  type RunTrigger,
  type TestStatus,
} from './common'
import {
  type ArtifactRef,
  artifactRefSchema,
  type IngestExecution,
  type IngestRunBatch,
} from './ingestion'

export const CONVENTIONS_VERSION = CONTRACT_VERSION

export const SPAN_NAMES = {
  run: 'test.run',
  case: 'test.case',
  step: 'test.step',
} as const

export const RESOURCE_ATTR = {
  serviceName: 'service.name',
  project: 'flakemetry.project',
  contractVersion: 'flakemetry.contract_version',
  idempotencyKey: 'flakemetry.idempotency_key',
  trigger: 'flakemetry.trigger',
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
  artifacts: 'test.artifacts',
} as const

export const EXCEPTION_EVENT = {
  name: 'exception',
  type: 'exception.type',
  message: 'exception.message',
  stacktrace: 'exception.stacktrace',
} as const

export type ResourceAttributeKey = (typeof RESOURCE_ATTR)[keyof typeof RESOURCE_ATTR]
export type SpanAttributeKey = (typeof SPAN_ATTR)[keyof typeof SPAN_ATTR]

const otlpAnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
  })
  .passthrough()

const otlpAttributeSchema = z.object({
  key: z.string(),
  value: otlpAnyValueSchema,
})

const nanoSchema = z.union([z.string(), z.number()])

const otlpEventSchema = z.object({
  timeUnixNano: nanoSchema.optional(),
  name: z.string().optional(),
  attributes: z.array(otlpAttributeSchema).default([]),
})

const otlpSpanSchema = z.object({
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: nanoSchema,
  endTimeUnixNano: nanoSchema,
  attributes: z.array(otlpAttributeSchema).default([]),
  status: z.object({ code: z.number().optional() }).optional(),
  events: z.array(otlpEventSchema).default([]),
})

const otlpScopeSpansSchema = z.object({
  spans: z.array(otlpSpanSchema).default([]),
})

const otlpResourceSpansSchema = z.object({
  resource: z.object({ attributes: z.array(otlpAttributeSchema).default([]) }).optional(),
  scopeSpans: z.array(otlpScopeSpansSchema).default([]),
})

export const otlpTraceRequestSchema = z.object({
  resourceSpans: z.array(otlpResourceSpansSchema).default([]),
})

export type OtlpAnyValue = z.infer<typeof otlpAnyValueSchema>
export type OtlpAttribute = z.infer<typeof otlpAttributeSchema>
export type OtlpSpan = z.infer<typeof otlpSpanSchema>
export type OtlpTraceRequest = z.infer<typeof otlpTraceRequestSchema>

const anyValueToPrimitive = (value: OtlpAnyValue): string | number | boolean | null => {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.boolValue !== undefined) return value.boolValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  return null
}

const toAttrMap = (attributes: OtlpAttribute[]): Map<string, string | number | boolean> => {
  const map = new Map<string, string | number | boolean>()
  for (const attribute of attributes) {
    const value = anyValueToPrimitive(attribute.value)
    if (value !== null) map.set(attribute.key, value)
  }
  return map
}

const nanoToDate = (nano: string | number): Date => new Date(Math.round(Number(nano) / 1_000_000))

const asString = (value: string | number | boolean | undefined): string | undefined =>
  value === undefined ? undefined : String(value)

const parseArtifacts = (raw: string | undefined): ArtifactRef[] | undefined => {
  if (!raw) return undefined
  try {
    const parsed = artifactRefSchema.array().safeParse(JSON.parse(raw))
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined
  } catch {
    return undefined
  }
}

class OtlpMappingError extends Error {}

export const otlpToIngestBatch = (request: OtlpTraceRequest): IngestRunBatch => {
  const resourceAttrs = new Map<string, string | number | boolean>()
  const spans: OtlpSpan[] = []
  for (const resourceSpan of request.resourceSpans) {
    for (const [key, value] of toAttrMap(resourceSpan.resource?.attributes ?? [])) {
      resourceAttrs.set(key, value)
    }
    for (const scopeSpan of resourceSpan.scopeSpans) {
      spans.push(...scopeSpan.spans)
    }
  }

  const runSpan = spans.find((span) => span.name === SPAN_NAMES.run)
  if (!runSpan) throw new OtlpMappingError('no test.run span in payload')
  const runAttrs = toAttrMap(runSpan.attributes)

  const pick = (key: string): string | undefined =>
    asString(resourceAttrs.get(key)) ?? asString(runAttrs.get(key))

  const project = pick(RESOURCE_ATTR.project)
  const commitSha = pick(RESOURCE_ATTR.commitSha)
  const branch = pick(RESOURCE_ATTR.branch)
  const ciProvider = pick(RESOURCE_ATTR.ciProvider)
  const trigger = pick(RESOURCE_ATTR.trigger)
  if (!project || !commitSha || !branch || !ciProvider || !trigger) {
    throw new OtlpMappingError('missing required resource attributes')
  }

  const prNumberRaw =
    resourceAttrs.get(RESOURCE_ATTR.prNumber) ?? runAttrs.get(RESOURCE_ATTR.prNumber)
  const idempotencyKey = pick(RESOURCE_ATTR.idempotencyKey) ?? runSpan.traceId
  if (!idempotencyKey) throw new OtlpMappingError('missing idempotency key and trace id')

  const caseSpans = spans
    .filter((span) => span.name === SPAN_NAMES.case)
    .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano))

  const executions: IngestExecution[] = []
  const lastIndexByFingerprint = new Map<string, number>()

  for (const span of caseSpans) {
    const attrs = toAttrMap(span.attributes)
    const fingerprint = asString(attrs.get(SPAN_ATTR.fingerprint))
    const title = asString(attrs.get(SPAN_ATTR.title))
    const filePath = asString(attrs.get(SPAN_ATTR.filePath))
    const status = asString(attrs.get(SPAN_ATTR.status)) as TestStatus | undefined
    if (!fingerprint || !title || !filePath || !status) {
      throw new OtlpMappingError('test.case span missing required attributes')
    }

    const attempt = Number(attrs.get(SPAN_ATTR.attempt) ?? 1)
    const durationMs = attrs.has(SPAN_ATTR.durationMs)
      ? Number(attrs.get(SPAN_ATTR.durationMs))
      : Math.max(0, Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1_000_000

    const explicitRetryOf = attrs.get(SPAN_ATTR.retryOf)
    const previousIndex = lastIndexByFingerprint.get(fingerprint)
    const retryOfIndex =
      explicitRetryOf !== undefined
        ? Number(explicitRetryOf)
        : attempt > 1 && previousIndex !== undefined
          ? previousIndex
          : undefined

    const exception = span.events.find((event) => event.name === EXCEPTION_EVENT.name)
    const exceptionAttrs = exception ? toAttrMap(exception.attributes) : undefined
    const message = exceptionAttrs && asString(exceptionAttrs.get(EXCEPTION_EVENT.message))
    const error = message
      ? {
          type: asString(exceptionAttrs?.get(EXCEPTION_EVENT.type)),
          message,
          stack: asString(exceptionAttrs?.get(EXCEPTION_EVENT.stacktrace)),
        }
      : undefined

    executions.push({
      filePath,
      suite: asString(attrs.get(SPAN_ATTR.suite)) ?? '',
      title,
      status,
      attempt,
      retryOfIndex,
      startedAt: nanoToDate(span.startTimeUnixNano),
      durationMs: Math.round(durationMs),
      error,
      artifacts: parseArtifacts(asString(attrs.get(SPAN_ATTR.artifacts))),
    })
    lastIndexByFingerprint.set(fingerprint, executions.length - 1)
  }

  const runFailed = runSpan.status?.code === 2 || executions.some((e) => e.status === 'fail')

  return {
    contractVersion: pick(RESOURCE_ATTR.contractVersion) ?? CONVENTIONS_VERSION,
    idempotencyKey,
    resource: {
      ciProvider: ciProvider as CiProvider,
      commitSha,
      branch,
      trigger: trigger as RunTrigger,
      ...(pick(RESOURCE_ATTR.ciRunId) ? { ciRunId: pick(RESOURCE_ATTR.ciRunId) } : {}),
      ...(prNumberRaw !== undefined ? { prNumber: Number(prNumberRaw) } : {}),
    },
    run: {
      status: (runFailed ? 'failed' : 'passed') as RunStatus,
      startedAt: nanoToDate(runSpan.startTimeUnixNano),
      finishedAt: nanoToDate(runSpan.endTimeUnixNano),
    },
    executions,
  }
}
