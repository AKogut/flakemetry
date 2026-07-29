import type { ObjectStore, StoredObject } from './store'

export interface MemoryObjectStoreOptions {
  now?: () => Date
  baseUrl?: string
}

export interface MemoryObjectStore extends ObjectStore {
  readonly objects: Map<string, { body: Uint8Array; contentType: string; lastModified: Date }>
}

export const createMemoryObjectStore = (
  options: MemoryObjectStoreOptions = {},
): MemoryObjectStore => {
  const now = options.now ?? (() => new Date())
  const baseUrl = options.baseUrl ?? 'https://memory.local'
  const objects = new Map<string, { body: Uint8Array; contentType: string; lastModified: Date }>()

  return {
    name: 'memory',
    objects,

    async presignUpload(key, _contentType, ttlSeconds = 900) {
      return `${baseUrl}/${key}?upload=1&ttl=${ttlSeconds}`
    },

    async presignDownload(key, ttlSeconds = 900) {
      return `${baseUrl}/${key}?ttl=${ttlSeconds}`
    },

    async put(key, body, contentType) {
      objects.set(key, { body, contentType, lastModified: now() })
    },

    async remove(keys) {
      for (const key of keys) objects.delete(key)
    },

    async list(prefix) {
      const out: StoredObject[] = []
      for (const [key, value] of objects) {
        if (key.startsWith(prefix)) {
          out.push({ key, size: value.body.byteLength, lastModified: value.lastModified })
        }
      }
      return out
    },
  }
}
