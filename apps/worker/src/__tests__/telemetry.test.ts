import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { metrics } from '@opentelemetry/api'
import { afterEach, describe, expect, it } from 'vitest'

import { initSelfTelemetry, observeQueueDepth, workerMetrics } from '../telemetry'

interface OtlpExport {
  resourceMetrics: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] }
    scopeMetrics: { metrics: { name: string }[] }[]
  }[]
}

const collector = async (): Promise<{ server: Server; url: string; received: OtlpExport[] }> => {
  const received: OtlpExport[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url === '/v1/metrics') {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpExport)
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}`, received }
}

describe('self-telemetry', () => {
  let server: Server | undefined

  afterEach(async () => {
    metrics.disable()
    await new Promise((resolve) => server?.close(resolve))
  })

  it('exports the instruments the worker records, not only the ones created after start-up', async () => {
    const sink = await collector()
    server = sink.server
    const shutdown = initSelfTelemetry({ endpoint: sink.url, exportIntervalMs: 60_000 })
    observeQueueDepth(async () => 4)

    workerMetrics.jobsProcessed.add(1)
    workerMetrics.processingLag.record(250)
    workerMetrics.processingDuration.record(900)
    await shutdown()

    const names = sink.received.flatMap((payload) =>
      payload.resourceMetrics.flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.name)),
      ),
    )
    expect(names).toEqual(
      expect.arrayContaining([
        'flakemetry.worker.jobs_processed',
        'flakemetry.worker.processing_lag',
        'flakemetry.worker.processing_duration',
        'flakemetry.worker.queue_depth',
      ]),
    )

    const attributes = sink.received[0]?.resourceMetrics[0]?.resource.attributes ?? []
    const attribute = (key: string) => attributes.find((entry) => entry.key === key)?.value
    expect(attribute('service.name')?.stringValue).toBe('flakemetry-worker')
    expect(attribute('service.instance.id')?.stringValue).toMatch(/.+/)
  })
})
