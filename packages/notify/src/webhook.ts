export const WEBHOOK_TIMEOUT_MS = 8_000

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.168\./,
]

const isBlockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host.length === 0) return true
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  if (host.startsWith('::ffff:')) return isBlockedHost(host.slice('::ffff:'.length))
  return PRIVATE_V4.some((range) => range.test(host))
}

export const isSafeWebhookUrl = (raw: string): boolean => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  return !isBlockedHost(url.hostname)
}

export const assertSafeWebhookUrl = (raw: string): void => {
  if (!isSafeWebhookUrl(raw)) {
    throw new Error('webhook url must be https and must not target a private or loopback address')
  }
}
