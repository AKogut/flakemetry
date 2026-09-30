import { randomUUID } from 'node:crypto'

import { type Meter, metrics } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

const SCOPE = 'flakemetry-worker'

const instruments = (meter: Meter) => ({
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
  rcaGenerated: meter.createCounter('flakemetry.worker.rca_generated', {
    description: 'root-cause analyses produced by the LLM',
  }),
  rcaSkipped: meter.createCounter('flakemetry.worker.rca_skipped', {
    description: 'RCA attempts whose model output could not be parsed',
  }),
  rcaBudgetExhausted: meter.createCounter('flakemetry.worker.rca_budget_exhausted', {
    description: 'RCA runs skipped because the daily token budget was spent',
  }),
  pluginSignals: meter.createCounter('flakemetry.worker.plugin_signals', {
    description: 'signals raised by analyzer plugins',
  }),
  pluginFailures: meter.createCounter('flakemetry.worker.plugin_failures', {
    description: 'analyzer plugin runs that threw, timed out or broke the contract',
  }),
})

export const workerMetrics = instruments(metrics.getMeter(SCOPE))

export const observeQueueDepth = (getDepth: () => Promise<number>): void => {
  metrics
    .getMeter(SCOPE)
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
      'service.instance.id': process.env.HOSTNAME || randomUUID(),
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: options.exportIntervalMs ?? 30_000,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(provider)
  Object.assign(workerMetrics, instruments(provider.getMeter(SCOPE)))
  return () => provider.shutdown()
}
