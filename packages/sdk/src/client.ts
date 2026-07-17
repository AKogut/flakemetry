import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  type IngestAck,
  ingestAckSchema,
  type IngestRunBatch,
  ingestRunBatchSchema,
} from '@flakemetry/contracts'

export interface IngestClientOptions {
  endpoint: string
  token: string
  fetchImpl?: typeof fetch
  bufferDir?: string | null
  now?: () => number
}

export interface IngestResult {
  ok: boolean
  status?: number
  ack?: IngestAck
  buffered?: boolean
  error?: string
}

export interface FlushResult {
  flushed: number
  remaining: number
}

export const INGEST_PATH = '/v1/ingest'

export class IngestClient {
  private readonly endpoint: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly bufferDir: string | null
  private readonly now: () => number

  constructor(options: IngestClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.bufferDir = options.bufferDir ?? null
    this.now = options.now ?? (() => 0)
  }

  private buffer(batch: IngestRunBatch): boolean {
    if (!this.bufferDir) return false
    try {
      mkdirSync(this.bufferDir, { recursive: true })
      const file = join(this.bufferDir, `${batch.idempotencyKey}-${this.now()}.json`)
      writeFileSync(file, JSON.stringify(batch))
      return true
    } catch {
      return false
    }
  }

  private async post(batch: IngestRunBatch): Promise<IngestResult> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}${INGEST_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          'idempotency-key': batch.idempotencyKey,
        },
        body: JSON.stringify(batch),
      })

      if (!response.ok) return { ok: false, status: response.status }

      const ack = ingestAckSchema.parse(await response.json())
      return { ok: true, status: response.status, ack }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async send(batch: IngestRunBatch): Promise<IngestResult> {
    const result = await this.post(batch)
    if (result.ok) return result
    return { ...result, buffered: this.buffer(batch) }
  }

  async flushBuffered(): Promise<FlushResult> {
    if (!this.bufferDir || !existsSync(this.bufferDir)) return { flushed: 0, remaining: 0 }

    const files = readdirSync(this.bufferDir).filter((name) => name.endsWith('.json'))
    let flushed = 0
    let remaining = 0

    for (const name of files) {
      const path = join(this.bufferDir, name)
      let batch: IngestRunBatch
      try {
        const parsed = ingestRunBatchSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
        if (!parsed.success) {
          unlinkSync(path)
          continue
        }
        batch = parsed.data
      } catch {
        unlinkSync(path)
        continue
      }
      const result = await this.post(batch)
      if (result.ok) {
        unlinkSync(path)
        flushed += 1
      } else {
        remaining += 1
      }
    }

    return { flushed, remaining }
  }
}
