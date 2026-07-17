import { getPrismaClient } from '@flakemetry/db'

import { buildApp } from './app'

const port = Number(process.env.PORT ?? 4000)
const host = process.env.HOST ?? '0.0.0.0'

const app = buildApp({ prisma: getPrismaClient() })

app
  .listen({ port, host })
  .then((address: string) => {
    process.stdout.write(`api listening on ${address}\n`)
  })
  .catch((error: unknown) => {
    process.stderr.write(`api failed to start: ${String(error)}\n`)
    process.exitCode = 1
  })
