import type { CommandModule } from '../registry'

export interface FlakyRow {
  testIdentityId: string
  title: string
  suite: string
  filePath: string
  score: number
  quarantined: boolean
  owner?: string | null
}

export interface FlakyQuery {
  endpoint: string
  token: string
  limit?: number
  minScore?: number
  quarantinedOnly?: boolean
  owner?: string
  fetchImpl?: typeof fetch
}

export type FlakyOutcome =
  { ok: true; rows: FlakyRow[] } | { ok: false; reason: string; hint?: string }

export const fetchFlaky = async (query: FlakyQuery): Promise<FlakyOutcome> => {
  const url = new URL('/v1/flaky', query.endpoint)
  url.searchParams.set('limit', String(query.limit ?? 20))
  if (query.minScore !== undefined) url.searchParams.set('minScore', String(query.minScore))
  if (query.owner) url.searchParams.set('owner', query.owner)

  let response: Response
  try {
    response = await (query.fetchImpl ?? fetch)(url.toString(), {
      headers: { authorization: `Bearer ${query.token}` },
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (response.status === 403) {
    return {
      ok: false,
      reason: 'the token is valid but not allowed to read',
      // The distinction matters: nothing about the token is wrong, it simply was not created
      // for this, and rotating it would not help.
      hint: 'create a token with the "read" scope under Settings → Ingest tokens',
    }
  }
  if (response.status === 401) {
    return { ok: false, reason: 'the token was rejected', hint: 'check FLAKEMETRY_TOKEN' }
  }
  if (!response.ok) {
    return { ok: false, reason: `the server answered ${response.status}` }
  }

  const body = (await response.json().catch(() => null)) as { items?: FlakyRow[] } | null
  const rows = body?.items ?? []
  return {
    ok: true,
    rows: query.quarantinedOnly ? rows.filter((row) => row.quarantined) : rows,
  }
}

export const renderFlakyTable = (rows: readonly FlakyRow[]): string => {
  if (rows.length === 0) return 'No flaky tests.'
  const width = Math.min(60, Math.max(...rows.map((row) => row.title.length)))
  return rows
    .map((row) => {
      const score = row.score.toFixed(2)
      const mark = row.quarantined ? ' [quarantined]' : ''
      return `${score}  ${row.title.slice(0, width).padEnd(width)}  ${row.filePath}${mark}`
    })
    .join('\n')
}

export const flakyCommand: CommandModule = {
  name: 'flaky',
  description: 'List the flaky tests for this project',
  register: (program, context) => {
    program
      .command('flaky')
      .description('List flaky tests, worst first')
      .option('--limit <n>', 'how many to show', '20')
      .option('--min-score <n>', 'only tests at or above this score')
      .option('--owner <owner>', 'restrict to a CODEOWNERS owner')
      .option('--quarantined', 'only tests that are quarantined', false)
      .option('--json', 'machine-readable output', false)
      .option('--endpoint <url>', 'API endpoint (overrides FLAKEMETRY_ENDPOINT)')
      .option('--token <token>', 'read token (overrides FLAKEMETRY_TOKEN)')
      .action(
        async (options: {
          limit?: string
          minScore?: string
          owner?: string
          quarantined?: boolean
          json?: boolean
          endpoint?: string
          token?: string
        }) => {
          const endpoint =
            options.endpoint ??
            context.env.FLAKEMETRY_ENDPOINT ??
            context.resolveConfig().config.endpoint
          const token = options.token ?? context.token
          if (!endpoint || !token) {
            process.stderr.write(
              'flakemetry: endpoint and token are required (set FLAKEMETRY_ENDPOINT and FLAKEMETRY_TOKEN)\n',
            )
            process.exitCode = 1
            return
          }

          const outcome = await fetchFlaky({
            endpoint,
            token,
            limit: Number(options.limit ?? 20),
            ...(options.minScore ? { minScore: Number(options.minScore) } : {}),
            ...(options.owner ? { owner: options.owner } : {}),
            quarantinedOnly: Boolean(options.quarantined),
          })

          if (!outcome.ok) {
            if (options.json) {
              process.stdout.write(`${JSON.stringify({ error: outcome.reason })}\n`)
            } else {
              process.stderr.write(`flakemetry: ${outcome.reason}\n`)
              if (outcome.hint) process.stderr.write(`  ${outcome.hint}\n`)
            }
            process.exitCode = 1
            return
          }

          process.stdout.write(
            options.json
              ? `${JSON.stringify(outcome.rows, null, 2)}\n`
              : `${renderFlakyTable(outcome.rows)}\n`,
          )
        },
      )
  },
}
