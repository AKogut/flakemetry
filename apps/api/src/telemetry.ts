import { randomUUID } from 'node:crypto'

import { type Meter, metrics } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

const SCOPE = 'flakemetry-api'

export const REQUEST_DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 200, 300, 500, 1_000, 2_500, 5_000, 10_000,
]

const instruments = (meter: Meter) => ({
  runsAccepted: meter.createCounter('flakemetry.ingest.runs_accepted', {
    description: 'accepted ingest runs',
  }),
  executionsAccepted: meter.createCounter('flakemetry.ingest.executions_accepted', {
    description: 'accepted test executions',
  }),
  rateLimited: meter.createCounter('flakemetry.ingest.rate_limited', {
    description: 'requests rejected by the rate limiter',
  }),
  backpressured: meter.createCounter('flakemetry.ingest.backpressured', {
    description: 'requests rejected due to queue backpressure',
  }),
  requestDuration: meter.createHistogram('flakemetry.http.server.duration', {
    description: 'request duration in milliseconds',
    unit: 'ms',
    advice: { explicitBucketBoundaries: REQUEST_DURATION_BUCKETS_MS },
  }),
})

export const apiMetrics = instruments(metrics.getMeter(SCOPE))

export const observeQueueDepth = (getDepth: () => Promise<number>): void => {
  metrics
    .getMeter(SCOPE)
    .createObservableGauge('flakemetry.queue.depth', { description: 'pending ingestion jobs' })
    .addCallback(async (result) => {
      result.observe(await getDepth())
    })
}

export const exportInterval = (env: NodeJS.ProcessEnv): number => {
  const value = Number(env.OTEL_METRIC_EXPORT_INTERVAL)
  return Number.isInteger(value) && value > 0 ? value : 30_000
}

export interface SelfTelemetryOptions {
  endpoint: string
  headers?: Record<string, string>
  exportIntervalMs?: number
  serviceName?: string
}

export const initSelfTelemetry = (options: SelfTelemetryOptions): (() => Promise<void>) => {
  const exporter = new OTLPMetricExporter({
    url: `${options.endpoint.replace(/\/+$/, '')}/v1/metrics`,
    headers: options.headers,
  })
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? 'flakemetry-api',
      'service.instance.id': process.env.HOSTNAME || randomUUID(),
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: options.exportIntervalMs ?? exportInterval(process.env),
      }),
    ],
  })
  metrics.setGlobalMeterProvider(provider)
  Object.assign(apiMetrics, instruments(provider.getMeter(SCOPE)))
  return () => provider.shutdown()
}
