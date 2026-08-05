import { redactToken } from '../config-loader'
import type { CommandModule } from '../registry'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

export interface DoctorParams {
  endpoint?: string | null
  token?: string | null
  configPath?: string | null
  fetchImpl?: typeof fetch
}

export const runDoctor = async (params: DoctorParams): Promise<Check[]> => {
  const checks: Check[] = []
  const fetchImpl = params.fetchImpl ?? fetch

  checks.push(
    params.configPath
      ? { name: 'config', status: 'ok', detail: `found ${params.configPath}` }
      : {
          name: 'config',
          status: 'warn',
          detail: 'no flakemetry.yml — endpoint and token must come from the environment',
        },
  )

  if (!params.endpoint) {
    checks.push({ name: 'endpoint', status: 'fail', detail: 'not set (FLAKEMETRY_ENDPOINT)' })
    return checks
  }
  checks.push({ name: 'endpoint', status: 'ok', detail: params.endpoint })

  try {
    const health = await fetchImpl(new URL('/health', params.endpoint).toString())
    checks.push(
      health.ok
        ? { name: 'reachable', status: 'ok', detail: `answered ${health.status}` }
        : { name: 'reachable', status: 'fail', detail: `answered ${health.status}` },
    )
  } catch (error) {
    checks.push({
      name: 'reachable',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    })
    return checks
  }

  if (!params.token) {
    checks.push({ name: 'token', status: 'fail', detail: 'not set (FLAKEMETRY_TOKEN)' })
    return checks
  }
  checks.push({ name: 'token', status: 'ok', detail: `present (${redactToken(params.token)})` })

  try {
    const probe = await fetchImpl(new URL('/v1/flaky?limit=1', params.endpoint).toString(), {
      headers: { authorization: `Bearer ${params.token}` },
    })
    if (probe.status === 401) {
      checks.push({ name: 'read scope', status: 'fail', detail: 'the token was rejected' })
    } else if (probe.status === 403) {
      // Not a broken token — a token created for something else. Saying "invalid" would send
      // someone off to rotate a credential that is working perfectly.
      checks.push({
        name: 'read scope',
        status: 'warn',
        detail: 'valid token without the read scope — uploads will work, queries will not',
      })
    } else if (probe.ok) {
      checks.push({ name: 'read scope', status: 'ok', detail: 'queries are allowed' })
    } else {
      checks.push({ name: 'read scope', status: 'warn', detail: `answered ${probe.status}` })
    }
  } catch (error) {
    checks.push({
      name: 'read scope',
      status: 'warn',
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  return checks
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' }

export const renderChecks = (checks: readonly Check[]): string =>
  checks.map((check) => `${SYMBOL[check.status]} ${check.name}: ${check.detail}`).join('\n')

export const worstStatus = (checks: readonly Check[]): CheckStatus =>
  checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok'

export const doctorCommand: CommandModule = {
  name: 'doctor',
  description: 'Diagnose configuration and connectivity',
  register: (program, context) => {
    program
      .command('doctor')
      .description('Check the configuration, the endpoint and what the token is allowed to do')
      .option('--json', 'machine-readable output', false)
      .action(async (options: { json?: boolean }) => {
        const resolved = context.resolveConfig()
        const checks = await runDoctor({
          endpoint: context.env.FLAKEMETRY_ENDPOINT ?? resolved.config.endpoint,
          token: context.token,
          configPath: resolved.configPath,
        })

        process.stdout.write(
          options.json ? `${JSON.stringify(checks, null, 2)}\n` : `${renderChecks(checks)}\n`,
        )

        // A warning is not a failure: a token that can upload but not query is a perfectly
        // valid CI setup, and exiting non-zero would break the pipeline that has it.
        if (worstStatus(checks) === 'fail') process.exitCode = 1
      })
  },
}
