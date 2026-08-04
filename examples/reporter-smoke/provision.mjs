import { appendFileSync } from 'node:fs'

import { generateToken, getPrismaClient, hashToken } from '@flakemetry/db'

export const RUNNERS = ['playwright', 'vitest', 'jest']

const prisma = getPrismaClient()

const stamp = Date.now().toString(36)
const org = await prisma.org.create({
  data: { name: `Reporter smoke ${stamp}`, slug: `reporter-smoke-${stamp}` },
})

const lines = []
for (const runner of RUNNERS) {
  const project = await prisma.project.create({
    data: { orgId: org.id, name: runner, slug: `${runner}-${stamp}` },
  })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'smoke', tokenHash: hashToken(raw) },
  })
  lines.push(`${runner.toUpperCase()}_PROJECT_ID=${project.id}`)
  lines.push(`${runner.toUpperCase()}_TOKEN=${raw}`)
}

// One project per runner, so a reporter that delivers nothing cannot hide behind
// another one's data — the count has to be right for each of them separately.
const target = process.env.GITHUB_ENV
if (target) appendFileSync(target, `${lines.join('\n')}\n`)
process.stdout.write(`${lines.join('\n')}\n`)

await prisma.$disconnect()
