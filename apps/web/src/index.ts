import { createServer } from 'node:http'

import { getPrismaClient } from '@flakemetry/db'

const prisma = getPrismaClient()
const port = Number(process.env.PORT ?? 3000)

const renderPage = async () => {
  const [runs, executions, flakyScores] = await Promise.all([
    prisma.run.count(),
    prisma.testExecution.count(),
    prisma.flakyScore.findMany({
      orderBy: { score: 'desc' },
      take: 10,
      include: { identity: true },
    }),
  ])

  const rows = flakyScores
    .map(
      (entry) =>
        `<tr><td>${entry.identity.suite}</td><td>${entry.identity.title}</td><td>${entry.score.toFixed(2)}</td><td>${entry.quarantineCandidate ? 'yes' : 'no'}</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html>
<head><title>Flakemetry</title><style>body{font-family:system-ui;margin:2rem;max-width:52rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}</style></head>
<body>
<h1>Flakemetry</h1>
<p>Full dashboard lands in M1. Platform stack is up: ${runs} runs, ${executions} executions ingested.</p>
<h2>Flaky board</h2>
<table><tr><th>Suite</th><th>Test</th><th>Score</th><th>Quarantine candidate</th></tr>${rows}</table>
</body>
</html>`
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', service: 'web' }))
    return
  }
  renderPage()
    .then((html) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    .catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error) }))
    })
})

server.listen(port, () => {
  process.stdout.write(`web listening on :${port}\n`)
})
