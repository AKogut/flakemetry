import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'

import { CONVENTIONS_VERSION, RESOURCE_ATTR } from './conventions'
import type { TestRunRecorder } from './recorder'
import { emitRunSpans } from './spans'

export interface OtlpExporterOptions {
  endpoint: string
  token: string
  timeoutMillis?: number
  compression?: boolean
}

export const OTLP_TRACES_PATH = '/v1/traces'

export const exportRunOverOtlp = async (
  recorder: TestRunRecorder,
  idempotencyKey: string,
  options: OtlpExporterOptions,
): Promise<void> => {
  const endpoint = options.endpoint.replace(/\/+$/, '')
  const { context } = recorder

  const resource = resourceFromAttributes({
    [RESOURCE_ATTR.serviceName]: 'flakemetry-sdk',
    [RESOURCE_ATTR.project]: context.project,
    [RESOURCE_ATTR.commitSha]: context.commitSha,
    [RESOURCE_ATTR.branch]: context.branch,
    [RESOURCE_ATTR.ciProvider]: context.ciProvider,
    [RESOURCE_ATTR.trigger]: context.trigger,
    [RESOURCE_ATTR.contractVersion]: CONVENTIONS_VERSION,
    [RESOURCE_ATTR.idempotencyKey]: idempotencyKey,
    ...(context.ciRunId ? { [RESOURCE_ATTR.ciRunId]: context.ciRunId } : {}),
    ...(context.prNumber ? { [RESOURCE_ATTR.prNumber]: context.prNumber } : {}),
  })

  const collector = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(collector)],
  })

  const exporter = new OTLPTraceExporter({
    url: `${endpoint}${OTLP_TRACES_PATH}`,
    headers: { authorization: `Bearer ${options.token}` },
    timeoutMillis: options.timeoutMillis ?? 10_000,
    compression: options.compression ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE,
  })

  try {
    const tracer = provider.getTracer('@flakemetry/sdk', CONVENTIONS_VERSION)
    emitRunSpans(tracer, recorder, { idempotencyKey })
    await provider.forceFlush()

    const spans = collector.getFinishedSpans()
    await new Promise<void>((resolve, reject) => {
      exporter.export([...spans], (result) => {
        if (result.code === 0) resolve()
        else reject(result.error ?? new Error('OTLP export failed'))
      })
    })
  } finally {
    await exporter.shutdown()
    await provider.shutdown()
  }
}
