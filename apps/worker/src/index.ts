import { getPrismaClient } from '@flakemetry/db'

const prisma = getPrismaClient()
const intervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000)

const heartbeat = async () => {
  const [runs, executions] = await Promise.all([prisma.run.count(), prisma.testExecution.count()])
  process.stdout.write(`worker heartbeat: runs=${runs} executions=${executions}\n`)
}

await heartbeat()
setInterval(() => {
  heartbeat().catch((error: unknown) => {
    process.stderr.write(`worker heartbeat failed: ${String(error)}\n`)
  })
}, intervalMs)
