import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'

/**
 * The generator yields NDJSON a line at a time and the browser wants a web stream, so the
 * bytes pass through gzip without ever being collected: an export large enough to matter
 * is one the dashboard must not hold in memory to send.
 */
export const gzippedExportBody = (lines: AsyncIterable<string>): ReadableStream => {
  const gzip = createGzip()
  Readable.from(lines).pipe(gzip)
  return Readable.toWeb(gzip) as ReadableStream
}
