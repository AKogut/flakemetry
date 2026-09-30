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

export interface SizeCapOptions {
  prefix?: string
  maxBytes: number
  batchSize?: number
}

export interface SizeCapResult {
  scanned: number
  bytesBefore: number
  bytesAfter: number
  deleted: string[]
}

export const pruneArtifactsToSize = async (
  store: ObjectStore,
  options: SizeCapOptions,
): Promise<SizeCapResult> => {
  const batchSize = options.batchSize ?? 1000
  const objects = await store.list(options.prefix ?? '')
  const bytesBefore = objects.reduce((total, object) => total + object.size, 0)

  let bytes = bytesBefore
  const keys: string[] = []
  const oldestFirst = [...objects].sort(
    (a, b) => a.lastModified.getTime() - b.lastModified.getTime() || a.key.localeCompare(b.key),
  )
  for (const object of oldestFirst) {
    if (bytes <= options.maxBytes) break
    keys.push(object.key)
    bytes -= object.size
  }

  for (let i = 0; i < keys.length; i += batchSize) {
    await store.remove(keys.slice(i, i + batchSize))
  }

  return { scanned: objects.length, bytesBefore, bytesAfter: bytes, deleted: keys }
}
