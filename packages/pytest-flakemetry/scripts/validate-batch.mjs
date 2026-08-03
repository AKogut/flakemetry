// Validates a batch emitted by the pytest plugin against the TypeScript
// ingestion contract, so the Python and JavaScript reporters cannot drift apart.
import { readFileSync } from 'node:fs'

import { ingestRunBatchSchema } from '@flakemetry/contracts'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/validate-batch.mjs <batch.json>')
  process.exit(1)
}

const parsed = ingestRunBatchSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
if (!parsed.success) {
  console.error(`${file} does not satisfy the ingestion contract:`)
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  process.exit(1)
}

const { executions, run } = parsed.data
console.log(`${file}: valid — ${executions.length} executions, run ${run.status}`)
