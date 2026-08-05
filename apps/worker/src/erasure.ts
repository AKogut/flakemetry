import type { PrismaClient } from '@flakemetry/db'
import { claimErasures, completeRequest, eraseTarget, failRequest } from '@flakemetry/queries'
import type { ObjectStore } from '@flakemetry/storage'

export interface ErasureSweepResult {
  completed: number
  failed: number
}

/**
 * Erasure runs here rather than in the request that asked for it: deleting a large project
 * outlives an HTTP timeout, and a request that gives up halfway would leave a tenant half
 * erased with nothing recording how far it got.
 */
export const runErasureSweep = async (
  prisma: PrismaClient,
  store: ObjectStore | null,
  onNotice: (message: string) => void = () => undefined,
): Promise<ErasureSweepResult> => {
  const claimed = await claimErasures(prisma)
  let completed = 0
  let failed = 0

  for (const request of claimed) {
    try {
      const outcome = await eraseTarget(prisma, store, request.target)
      await completeRequest(prisma, request.id, {
        rowCount: outcome.rowsDeleted,
        artifactCount: outcome.artifactsDeleted,
        residue: outcome.residue,
        verified: outcome.verified,
      })

      if (outcome.verified) {
        completed += 1
        onNotice(
          `erased ${request.subject}: ${outcome.rowsDeleted} row(s), ${outcome.artifactsDeleted} artifact(s)`,
        )
      } else {
        // Data survived a deletion the tenant was told had happened. Nothing about that is
        // routine, and the sweep will not retry it — it needs someone to look.
        failed += 1
        onNotice(
          `erasure of ${request.subject} left data behind: ${JSON.stringify(outcome.residue)}`,
        )
      }
    } catch (error) {
      failed += 1
      await failRequest(prisma, request.id, error instanceof Error ? error.message : String(error))
      onNotice(`erasure of ${request.subject} failed ${String(error)}`)
    }
  }

  return { completed, failed }
}

const ERASURE_INTERVAL_MS = 60 * 1000

export const startErasureSweeps = (prisma: PrismaClient, store: ObjectStore | null): void => {
  const sweep = (): void => {
    void runErasureSweep(prisma, store, (message) =>
      process.stdout.write(`worker: ${message}\n`),
    ).catch((error: unknown) => {
      process.stderr.write(`worker: erasure sweep failed ${String(error)}\n`)
    })
  }

  sweep()
  setInterval(sweep, ERASURE_INTERVAL_MS).unref()
}
