import { describe, expect, it } from 'vitest'

import {
  ingestRunBatchSchema,
  otlpToIngestBatch,
  otlpTraceRequestSchema,
  RESOURCE_ATTR,
  SPAN_ATTR,
  SPAN_NAMES,
} from '../index'

const s = (value: string) => ({ stringValue: value })
const i = (value: number) => ({ intValue: String(value) })

const RUN_START = Date.parse('2026-07-16T10:00:00Z') * 1_000_000
const nano = (ms: number) => String(RUN_START + ms * 1_000_000)

const request = () => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: RESOURCE_ATTR.project, value: s('web') },
          { key: RESOURCE_ATTR.commitSha, value: s('abc1234') },
          { key: RESOURCE_ATTR.branch, value: s('main') },
          { key: RESOURCE_ATTR.ciProvider, value: s('github_actions') },
          { key: RESOURCE_ATTR.trigger, value: s('push') },
          { key: RESOURCE_ATTR.idempotencyKey, value: s('run-000042') },
          { key: RESOURCE_ATTR.prNumber, value: i(7) },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'a'.repeat(32),
              spanId: 'b'.repeat(16),
              name: SPAN_NAMES.run,
              startTimeUnixNano: nano(0),
              endTimeUnixNano: nano(5000),
              status: { code: 2 },
              attributes: [],
              events: [],
            },
            {
              traceId: 'a'.repeat(32),
              spanId: 'c'.repeat(16),
              parentSpanId: 'b'.repeat(16),
              name: SPAN_NAMES.case,
              startTimeUnixNano: nano(10),
              endTimeUnixNano: nano(1810),
              attributes: [
                { key: SPAN_ATTR.fingerprint, value: s('fp-login') },
                { key: SPAN_ATTR.suite, value: s('auth') },
                { key: SPAN_ATTR.title, value: s('logs in') },
                { key: SPAN_ATTR.filePath, value: s('e2e/login.spec.ts') },
                { key: SPAN_ATTR.status, value: s('fail') },
                { key: SPAN_ATTR.attempt, value: i(1) },
                { key: SPAN_ATTR.durationMs, value: i(1800) },
              ],
              events: [
                {
                  name: 'exception',
                  attributes: [
                    { key: 'exception.type', value: s('TimeoutError') },
                    { key: 'exception.message', value: s('Timeout 30000ms exceeded') },
                    { key: 'exception.stacktrace', value: s('at login') },
                  ],
                },
              ],
            },
            {
              traceId: 'a'.repeat(32),
              spanId: 'd'.repeat(16),
              parentSpanId: 'b'.repeat(16),
              name: SPAN_NAMES.case,
              startTimeUnixNano: nano(1900),
              endTimeUnixNano: nano(3300),
              attributes: [
                { key: SPAN_ATTR.fingerprint, value: s('fp-login') },
                { key: SPAN_ATTR.suite, value: s('auth') },
                { key: SPAN_ATTR.title, value: s('logs in') },
                { key: SPAN_ATTR.filePath, value: s('e2e/login.spec.ts') },
                { key: SPAN_ATTR.status, value: s('flaky') },
                { key: SPAN_ATTR.attempt, value: i(2) },
                { key: SPAN_ATTR.durationMs, value: i(1400) },
              ],
              events: [],
            },
          ],
        },
      ],
    },
  ],
})

describe('otlpToIngestBatch', () => {
  it('parses a spec-conformant OTLP request', () => {
    expect(() => otlpTraceRequestSchema.parse(request())).not.toThrow()
  })

  it('maps run + case spans into a contract-valid ingest batch', () => {
    const batch = otlpToIngestBatch(otlpTraceRequestSchema.parse(request()))
    const parsed = ingestRunBatchSchema.parse(batch)

    expect(parsed.idempotencyKey).toBe('run-000042')
    expect(parsed.resource.commitSha).toBe('abc1234')
    expect(parsed.resource.prNumber).toBe(7)
    expect(parsed.run.status).toBe('failed')
    expect(parsed.executions).toHaveLength(2)
  })

  it('reconstructs retry linkage from attempt ordering', () => {
    const batch = otlpToIngestBatch(otlpTraceRequestSchema.parse(request()))
    expect(batch.executions[0]?.attempt).toBe(1)
    expect(batch.executions[0]?.retryOfIndex).toBeUndefined()
    expect(batch.executions[1]?.attempt).toBe(2)
    expect(batch.executions[1]?.retryOfIndex).toBe(0)
  })

  it('lifts the exception event into a structured error', () => {
    const batch = otlpToIngestBatch(otlpTraceRequestSchema.parse(request()))
    expect(batch.executions[0]?.error).toEqual({
      type: 'TimeoutError',
      message: 'Timeout 30000ms exceeded',
      stack: 'at login',
    })
    expect(batch.executions[1]?.error).toBeUndefined()
  })

  it('falls back to the run trace id when no idempotency key is present', () => {
    const req = request()
    req.resourceSpans[0]!.resource!.attributes = req.resourceSpans[0]!.resource!.attributes.filter(
      (attribute) => attribute.key !== RESOURCE_ATTR.idempotencyKey,
    )
    const batch = otlpToIngestBatch(otlpTraceRequestSchema.parse(req))
    expect(batch.idempotencyKey).toBe('a'.repeat(32))
  })

  it('throws when no run span is present', () => {
    const req = request()
    req.resourceSpans[0]!.scopeSpans[0]!.spans = req.resourceSpans[0]!.scopeSpans[0]!.spans.filter(
      (span) => span.name !== SPAN_NAMES.run,
    )
    expect(() => otlpToIngestBatch(otlpTraceRequestSchema.parse(req))).toThrow(/test.run/)
  })
})
