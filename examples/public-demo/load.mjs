import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { generateToken, getPrismaClient, hashToken } from '@flakemetry/db'

import { readBatches } from './lib/history.mjs'
import { PROJECTS } from './projects.mjs'

const [history, output] = process.argv.slice(2)
const endpoint = (process.env.FLAKEMETRY_ENDPOINT ?? 'http://localhost:4000').replace(/\/+$/, '')
if (!history || !output) {
  process.stderr.write('usage: load.mjs <history directory> <provisioned.json>\n')
  process.exit(1)
}

const prisma = getPrismaClient()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const send = async (token, batch) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${endpoint}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(batch),
    })
    if (response.ok) return
    if (response.status !== 429 && response.status !== 503) {
      throw new Error(`${batch.idempotencyKey}: ${response.status} ${await response.text()}`)
    }
    await sleep(Number(response.headers.get('retry-after') ?? 5) * 1000)
  }
  throw new Error(`${batch.idempotencyKey}: still refused after retries`)
}

const org = await prisma.org.create({ data: { name: 'Real projects', slug: 'real-projects' } })
const provisioned = []

for (const project of PROJECTS) {
  const row = await prisma.project.create({
    data: {
      orgId: org.id,
      name: project.name,
      slug: project.slug,
      public: true,
      repository: `https://github.com/${project.repo}`,
      badgeToken: `bdg_${randomBytes(16).toString('hex')}`,
    },
  })
  const token = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: row.id, name: 'demo', tokenHash: hashToken(token) },
  })

  const batches = readBatches(history, project.slug)
  for (const batch of batches) await send(token, batch)
  process.stdout.write(`${project.slug}: sent ${batches.length} run(s)\n`)
  provisioned.push({ ...project, projectId: row.id, badgeToken: row.badgeToken })
}

const deadline = Date.now() + 30 * 60 * 1000
for (;;) {
  const open = await prisma.ingestionJob.count({
    where: { status: { in: ['pending', 'processing'] } },
  })
  if (open === 0) break
  if (Date.now() > deadline) throw new Error(`${open} job(s) still open after 30 minutes`)
  await sleep(2000)
}

const dead = await prisma.ingestionJob.findMany({
  where: { status: 'dead' },
  select: { idempotencyKey: true, lastError: true },
})
if (dead.length > 0) {
  for (const job of dead) process.stderr.write(`${job.idempotencyKey}: ${job.lastError}\n`)
  throw new Error(`${dead.length} run(s) could not be processed`)
}

writeFileSync(output, JSON.stringify(provisioned, null, 2))
await prisma.$disconnect()
process.stdout.write('loaded\n')
