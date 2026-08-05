# Webhooks

A signed HTTP POST to your own endpoint whenever a test flakes, a quarantine changes, or a
root-cause analysis is ready. Add one under **Settings → Notifications** with kind **Signed
webhook**.

## Verifying a delivery

Every request carries three headers:

| Header | Contents |
| --- | --- |
| `X-Flakemetry-Event` | `flaky_detected`, `quarantine_changed` or `rca_ready` |
| `X-Flakemetry-Delivery` | Stable id for this delivery |
| `X-Flakemetry-Signature` | `t=<unix seconds>,v1=<hex hmac>` |

The signature is HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` using the secret shown
beside the channel.

**Verify it, and verify it correctly.** An endpoint that trusts an unverified body is an
endpoint anyone can post to.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_SECONDS = 300

export const isGenuine = (secret, header, rawBody) => {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t))
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false

  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(parts.v1 ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}
```

Two things that are easy to get wrong:

- Sign the **raw** body, not a re-serialised object. `JSON.parse` then `JSON.stringify` can
  reorder keys and the signature will not match.
- Compare in **constant time**. A plain `===` on a signature leaks it a byte at a time to
  anyone who can measure the response.

The timestamp is inside what the signature covers, so checking its age gives replay
protection. Without that check, a captured request stays valid forever.

## What we do before sending

The address is arbitrary and typed by a user, which is exactly the shape of a
server-side request forgery. So:

- **https only.** No plaintext, and no other schemes.
- **The hostname must resolve to a public address.** Rejecting names that *look* internal is
  not enough: a perfectly ordinary hostname can resolve to `169.254.169.254` and reach the
  cloud metadata service. Every resolved address is checked, not just the first — a name
  answering with one public and one private address would otherwise be a coin toss.
- **Redirects are never followed.** A `302` to an internal address would defeat every check
  above, and no legitimate receiver needs one.
- **Eight second timeout.** A receiver that never answers must not hold the worker.
- Response bodies are truncated and never parsed.

::: warning What this does not cover
DNS rebinding — where the answer changes between our check and the connection — is not fully
closed. Doing so means pinning the connection to the address that was verified, which is
worth doing and is not done yet. If your instance runs somewhere with a metadata service or a
reachable private network, egress-filter the worker rather than relying on this alone.
:::

## The secret

Generated server-side when the channel is created, never taken from the form: a secret the
caller chooses is one the caller can forge deliveries with.

It is stored in the clear, because signing needs the secret itself — unlike an ingest token it
cannot be hashed. Anyone who can read your dashboard can read it. To rotate, delete the
channel and add it again.

A webhook channel with no secret is **not delivered to** at all. Sending unsigned would be
worse than not sending: the receiver would have no way to tell the request came from here.

## Retries

A failed delivery is logged and not retried. Deduplication already suppresses repeats of the
same event within the dedupe window, so a receiver that was briefly down misses that event
rather than being flooded when it returns. If you need at-least-once delivery, poll the
[read API](/reference/api) instead — it is the durable source.
