import { metrics } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

const meter = metrics.getMeter('flakemetry-api')

export const apiMetrics = {
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
  }),
}

export const observeQueueDepth = (getDepth: () => Promise<number>): void => {
  meter
    .createObservableGauge('flakemetry.queue.depth', { description: 'pending ingestion jobs' })
    .addCallback(async (result) => {
      result.observe(await getDepth())
    })
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
    resource: resourceFromAttributes({ 'service.name': options.serviceName ?? 'flakemetry-api' }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: options.exportIntervalMs ?? 30_000,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(provider)
  return () => provider.shutdown()
}
