import { metrics } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

const meter = metrics.getMeter('flakemetry-worker')

export const workerMetrics = {
  jobsProcessed: meter.createCounter('flakemetry.worker.jobs_processed', {
    description: 'ingestion jobs processed successfully',
  }),
  jobsFailed: meter.createCounter('flakemetry.worker.jobs_failed', {
    description: 'ingestion jobs that failed processing',
  }),
  jobsDeadLettered: meter.createCounter('flakemetry.worker.jobs_dead_lettered', {
    description: 'ingestion jobs moved to the dead letter state',
  }),
  processingLag: meter.createHistogram('flakemetry.worker.processing_lag', {
    description: 'time between a job being enqueued and picked up',
    unit: 'ms',
  }),
  processingDuration: meter.createHistogram('flakemetry.worker.processing_duration', {
    description: 'time spent processing a job',
    unit: 'ms',
  }),
}

export const observeQueueDepth = (getDepth: () => Promise<number>): void => {
  meter
    .createObservableGauge('flakemetry.worker.queue_depth', {
      description: 'pending ingestion jobs',
    })
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
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? 'flakemetry-worker',
    }),
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
