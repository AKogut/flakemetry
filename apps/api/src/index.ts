import { getPrismaClient } from '@flakemetry/db'

import { buildApp } from './app'
import { initSelfTelemetry } from './telemetry'

export type { AppRouter } from './app'

const port = Number(process.env.PORT ?? 4000)
const host = process.env.HOST ?? '0.0.0.0'

const selfOtelEndpoint = process.env.FLAKEMETRY_SELF_OTEL_ENDPOINT
if (selfOtelEndpoint) {
  const shutdown = initSelfTelemetry({ endpoint: selfOtelEndpoint })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown()
    })
  }
}

const maxQueueDepth = process.env.FLAKEMETRY_MAX_QUEUE_DEPTH
  ? Number(process.env.FLAKEMETRY_MAX_QUEUE_DEPTH)
  : undefined

const app = buildApp({
  prisma: getPrismaClient(),
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization'],
  },
  maxQueueDepth,
})

app
  .listen({ port, host })
  .then((address: string) => {
    process.stdout.write(`api listening on ${address}\n`)
  })
  .catch((error: unknown) => {
    process.stderr.write(`api failed to start: ${String(error)}\n`)
    process.exitCode = 1
  })
