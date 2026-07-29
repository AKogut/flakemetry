import type { ObjectStore } from './store'

export interface PruneOptions {
  prefix?: string
  olderThanDays: number
  now?: Date
  batchSize?: number
}

export interface PruneResult {
  scanned: number
  deleted: string[]
}

export const pruneArtifacts = async (
  store: ObjectStore,
  options: PruneOptions,
): Promise<PruneResult> => {
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000
  const batchSize = options.batchSize ?? 1000

  const objects = await store.list(options.prefix ?? '')
  const expired = objects.filter((object) => object.lastModified.getTime() < cutoff)
  const keys = expired.map((object) => object.key)

  for (let i = 0; i < keys.length; i += batchSize) {
    await store.remove(keys.slice(i, i + batchSize))
  }

  return { scanned: objects.length, deleted: keys }
}
