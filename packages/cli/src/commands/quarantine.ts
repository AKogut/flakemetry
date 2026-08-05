import type { CommandModule } from '../registry'

export type QuarantineDecision = 'quarantined' | 'released' | 'auto'

export interface QuarantineRequest {
  endpoint: string
  token: string
  testIdentityId: string
  decision: QuarantineDecision
  reason?: string
  fetchImpl?: typeof fetch
}

export type QuarantineOutcome =
  | { ok: true; quarantined: boolean; override: string | null; changed: boolean }
  | { ok: false; reason: string; hint?: string }

export const setQuarantineState = async (
  request: QuarantineRequest,
): Promise<QuarantineOutcome> => {
  const url = new URL(
    `/v1/tests/${encodeURIComponent(request.testIdentityId)}/quarantine`,
    request.endpoint,
  )

  let response: Response
  try {
    response = await (request.fetchImpl ?? fetch)(url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        decision: request.decision,
        ...(request.reason ? { reason: request.reason } : {}),
      }),
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (response.status === 403) {
    return {
      ok: false,
      reason: 'the token is valid but not allowed to change quarantine state',
      // Its own scope on purpose: quarantining stops a test failing the build, so an
      // ingest token pasted into every CI job does not get to make that call.
      hint: 'create a token with the "quarantine" scope under Settings → Ingest tokens',
    }
  }
  if (response.status === 401) {
    return { ok: false, reason: 'the token was rejected', hint: 'check FLAKEMETRY_TOKEN' }
  }
  if (response.status === 404) {
    return { ok: false, reason: 'no such test in this project' }
  }
  if (!response.ok) {
    return { ok: false, reason: `the server answered ${response.status}` }
  }

  const body = (await response.json().catch(() => null)) as {
    quarantined?: boolean
    override?: string | null
    changed?: boolean
  } | null

  return {
    ok: true,
    quarantined: Boolean(body?.quarantined),
    override: body?.override ?? null,
    changed: Boolean(body?.changed),
  }
}

export const describeQuarantine = (outcome: Extract<QuarantineOutcome, { ok: true }>): string => {
  if (outcome.override === null) {
    return 'handed back to the scorer — it decides from the next run'
  }
  return outcome.quarantined
    ? 'quarantined — the scorer will not release it until you hand it back'
    : 'released — the scorer will not quarantine it again until you hand it back'
}

export const quarantineCommand: CommandModule = {
  name: 'quarantine',
  description: 'Quarantine a test, release it, or hand it back to the scorer',
  register: (program, context) => {
    program
      .command('quarantine')
      .description('Quarantine a test so it stops failing the build')
      .argument('<testIdentityId>', 'the test identity id')
      .option('--release', 'release the test instead of quarantining it', false)
      .option('--auto', 'hand the test back to the scorer', false)
      .option('--reason <text>', 'why, shown beside the test')
      .option('--json', 'machine-readable output', false)
      .option('--endpoint <url>', 'API endpoint (overrides FLAKEMETRY_ENDPOINT)')
      .option('--token <token>', 'token with the quarantine scope (overrides FLAKEMETRY_TOKEN)')
      .action(
        async (
          testIdentityId: string,
          options: {
            release?: boolean
            auto?: boolean
            reason?: string
            json?: boolean
            endpoint?: string
            token?: string
          },
        ) => {
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

          if (options.release && options.auto) {
            process.stderr.write('flakemetry: pass one of --release or --auto, not both\n')
            process.exitCode = 1
            return
          }

          const decision: QuarantineDecision = options.auto
            ? 'auto'
            : options.release
              ? 'released'
              : 'quarantined'

          const outcome = await setQuarantineState({
            endpoint,
            token,
            testIdentityId,
            decision,
            ...(options.reason ? { reason: options.reason } : {}),
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
              ? `${JSON.stringify(outcome)}\n`
              : `flakemetry: ${describeQuarantine(outcome)}\n`,
          )
        },
      )
  },
}
