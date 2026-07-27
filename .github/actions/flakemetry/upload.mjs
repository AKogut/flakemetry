import { existsSync, readFileSync } from 'node:fs'

const endpoint = (process.env.FLAKEMETRY_ENDPOINT || '').replace(/\/+$/, '')
const token = process.env.FLAKEMETRY_TOKEN || ''
const file = process.env.FLAKEMETRY_RESULTS_FILE || 'flakemetry-results.json'
const failOnError = /^(1|true)$/i.test(process.env.FLAKEMETRY_FAIL_ON_ERROR || '')

const finish = (ok, message) => {
  process.stdout.write(`flakemetry: ${message}\n`)
  process.exit(!ok && failOnError ? 1 : 0)
}

if (!endpoint || !token) finish(false, 'skipped — endpoint and token are required')
if (!existsSync(file)) finish(false, `skipped — results file not found: ${file}`)

let batch
try {
  batch = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  finish(false, `failed — could not parse ${file}: ${error.message}`)
}

if (!batch || typeof batch.idempotencyKey !== 'string')
  finish(false, `failed — ${file} is not a Flakemetry results file`)

try {
  const response = await fetch(`${endpoint}/v1/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': batch.idempotencyKey,
    },
    body: JSON.stringify(batch),
  })
  if (!response.ok) finish(false, `failed — ingestion returned ${response.status}`)
  const ack = await response.json().catch(() => ({}))
  const accepted = ack.acceptedExecutions ?? batch.executions?.length ?? 0
  finish(true, `uploaded ${accepted} execution(s) (receipt ${ack.receiptId ?? 'n/a'})`)
} catch (error) {
  finish(false, `failed — ${error.message}`)
}
