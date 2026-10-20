import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { gzippedExportBody } from '../export-stream'

const lines = async function* (count: number): AsyncGenerator<string> {
  for (let index = 0; index < count; index += 1) yield `{"n":${index}}\n`
}

const read = async (stream: ReadableStream): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Uint8Array)
  }
  return chunks
}

const drain = async (stream: ReadableStream): Promise<Buffer> => Buffer.concat(await read(stream))

describe('gzippedExportBody', () => {
  it('produces a gzip a browser can save and gunzip can open', async () => {
    const body = await drain(gzippedExportBody(lines(3)))

    // The response is served as a .gz file rather than a gzip content-encoding, so the
    // bytes on the wire have to be a real archive rather than a transfer artefact.
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(gunzipSync(body).toString('utf8')).toBe('{"n":0}\n{"n":1}\n{"n":2}\n')
  })

  it('carries more than fits in one chunk', async () => {
    const chunks = await read(gzippedExportBody(lines(20_000)))
    const inflated = gunzipSync(Buffer.concat(chunks)).toString('utf8').trimEnd().split('\n')

    expect(chunks.length).toBeGreaterThan(1)
    expect(inflated).toHaveLength(20_000)
    expect(inflated.at(-1)).toBe('{"n":19999}')
  }, 30_000)

  it('ends the stream on an empty export rather than hanging', async () => {
    const body = await drain(gzippedExportBody(lines(0)))

    expect(gunzipSync(body).toString('utf8')).toBe('')
  })
})
