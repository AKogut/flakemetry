import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'

import { isSafeWebhookUrl, WEBHOOK_TIMEOUT_MS } from './webhook'

export const SIGNATURE_HEADER = 'x-flakemetry-signature'
export const EVENT_HEADER = 'x-flakemetry-event'
export const DELIVERY_HEADER = 'x-flakemetry-delivery'

/** Receivers should reject anything older than this, and the docs say so. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

const MAX_RESPONSE_CHARS = 200

export const generateWebhookSecret = (): string => `whsec_${randomBytes(32).toString('hex')}`

/**
 * Signed over `timestamp.body` rather than the body alone, so a captured request cannot be
 * replayed later: the timestamp is inside what the signature covers, and a receiver that
 * checks its age gets replay protection for free.
 */
export const signWebhook = (secret: string, timestamp: number, body: string): string =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

export const signatureHeader = (secret: string, timestamp: number, body: string): string =>
  `t=${timestamp},v1=${signWebhook(secret, timestamp, body)}`

/**
 * Provided so receivers written against this codebase have a correct comparison to copy.
 * A plain `===` on a signature leaks it a byte at a time to anyone who can measure.
 */
export const verifyWebhook = (
  secret: string,
  timestamp: number,
  body: string,
  candidate: string,
): boolean => {
  const expected = Buffer.from(signWebhook(secret, timestamp, body), 'utf8')
  const given = Buffer.from(candidate, 'utf8')
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

const PRIVATE_V4_OCTETS = (address: string): boolean => {
  const parts = address.split('.').map(Number)
  const [a = 0, b = 0] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

const isPrivateAddress = (address: string, family: number): boolean => {
  if (family === 4) return PRIVATE_V4_OCTETS(address)
  const host = address.toLowerCase()
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  if (host.startsWith('::ffff:')) return PRIVATE_V4_OCTETS(host.slice('::ffff:'.length))
  return false
}

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>

const defaultLookup: Lookup = async (hostname) => dnsLookup(hostname, { all: true })

/**
 * The name check alone is not enough. `isSafeWebhookUrl` rejects hostnames that *look*
 * internal, but a public name resolving to 169.254.169.254 passes it and reaches the cloud
 * metadata service — the standard way a webhook feature becomes an SSRF.
 *
 * Every resolved address has to be public. Not the first one: a name that returns one public
 * and one private address would otherwise be a coin toss.
 *
 * This does not fully close DNS rebinding, where the answer changes between this check and
 * the connection. Pinning the connection to the address we verified needs a custom dispatcher
 * and is worth doing; until then an operator who cares should egress-filter the worker, and
 * the documentation says exactly that rather than implying more than is true.
 */
export const resolvesToPublicAddress = async (
  hostname: string,
  lookup: Lookup = defaultLookup,
): Promise<boolean> => {
  try {
    const addresses = await lookup(hostname)
    if (addresses.length === 0) return false
    return addresses.every((entry) => !isPrivateAddress(entry.address, entry.family))
  } catch {
    return false
  }
}

export interface WebhookDelivery {
  ok: boolean
  status?: number
  error?: string
}

export interface DeliverWebhookOptions {
  url: string
  secret: string
  event: string
  payload: unknown
  deliveryId: string
  now?: () => number
  fetchImpl?: typeof fetch
  lookup?: Lookup
  timeoutMs?: number
}

export const deliverWebhook = async (options: DeliverWebhookOptions): Promise<WebhookDelivery> => {
  if (!isSafeWebhookUrl(options.url)) {
    return { ok: false, error: 'url must be https and must not name a private address' }
  }

  const target = new URL(options.url)
  if (!(await resolvesToPublicAddress(target.hostname, options.lookup))) {
    return { ok: false, error: 'hostname resolves to a private address' }
  }

  const body = JSON.stringify(options.payload)
  const timestamp = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WEBHOOK_TIMEOUT_MS)

  try {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      method: 'POST',
      // A 302 to the metadata service would defeat every check above, and following one is
      // never something a webhook receiver legitimately needs.
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'flakemetry-webhook/1',
        [EVENT_HEADER]: options.event,
        [DELIVERY_HEADER]: options.deliveryId,
        [SIGNATURE_HEADER]: signatureHeader(options.secret, timestamp, body),
      },
      body,
    })

    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: response.status, error: 'redirects are not followed' }
    }
    if (!response.ok) {
      // Read a little of the body for the operator, never enough to be a place to stash data,
      // and never parsed.
      const detail = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: detail.slice(0, MAX_RESPONSE_CHARS) }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: controller.signal.aborted ? 'timed out' : message }
  } finally {
    clearTimeout(timer)
  }
}
