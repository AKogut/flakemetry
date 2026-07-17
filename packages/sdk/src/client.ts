import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type IngestAck, ingestAckSchema, type IngestRunBatch } from '@flakemetry/contracts'

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

  async send(batch: IngestRunBatch): Promise<IngestResult> {
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

      if (!response.ok) {
        const buffered = this.buffer(batch)
        return { ok: false, status: response.status, buffered }
      }

      const ack = ingestAckSchema.parse(await response.json())
      return { ok: true, status: response.status, ack }
    } catch (error) {
      const buffered = this.buffer(batch)
      return { ok: false, buffered, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
