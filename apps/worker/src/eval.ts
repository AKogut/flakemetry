import { readFileSync, writeFileSync } from 'node:fs'

import {
  ACTIVE_RCA_PROMPT_VERSION,
  compareToBaseline,
  type EvalReport,
  RCA_PROMPT_VERSIONS,
  resolveProvider,
  runEval,
} from '@flakemetry/ai'
import { PrismaClient } from '@flakemetry/db'
import { buildEvalSetFromFeedback } from '@flakemetry/queries'

export interface EvalArgs {
  projectId: string
  promptVersion: string
  baselineFile?: string
  writeBaseline?: string
}

export type EvalArgsResult = { ok: true; args: EvalArgs } | { ok: false; reason: string }

export const parseEvalArgs = (argv: readonly string[]): EvalArgsResult => {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    if (index < 0) return undefined
    const value = argv[index + 1]
    return value === undefined || value.startsWith('--') ? undefined : value
  }

  const projectId = flag('project')
  if (!projectId) return { ok: false, reason: '--project <projectId> is required' }

  const promptVersion = flag('prompt') ?? ACTIVE_RCA_PROMPT_VERSION
  if (!RCA_PROMPT_VERSIONS[promptVersion]) {
    return {
      ok: false,
      reason: `--prompt must be one of ${Object.keys(RCA_PROMPT_VERSIONS).join(', ')}, got "${promptVersion}"`,
    }
  }

  return {
    ok: true,
    args: {
      projectId,
      promptVersion,
      baselineFile: flag('baseline'),
      writeBaseline: flag('write-baseline'),
    },
  }
}

const main = async (): Promise<void> => {
  const parsed = parseEvalArgs(process.argv.slice(2))
  if (!parsed.ok) {
    process.stderr.write(`worker: ${parsed.reason}\n`)
    process.exitCode = 1
    return
  }
  const { projectId, promptVersion, baselineFile, writeBaseline } = parsed.args

  const provider = resolveProvider(process.env)
  if (!provider) {
    process.stderr.write(
      'worker: no LLM provider configured — set FLAKEMETRY_AI_* to run an eval\n',
    )
    process.exitCode = 1
    return
  }

  const prisma = new PrismaClient()
  try {
    const cases = await buildEvalSetFromFeedback(prisma, projectId)
    if (cases.length === 0) {
      process.stderr.write(
        'worker: the eval set is empty — it is built from reviewed reports carrying a written correction\n',
      )
      process.exitCode = 1
      return
    }

    const report = await runEval(
      provider,
      cases.map((entry) => ({ ...entry, input: { ...entry.input, promptVersion } })),
      promptVersion,
    )

    process.stdout.write(
      `worker: prompt ${report.promptVersion} over ${report.cases.length} case(s) — ` +
        `mean score ${report.meanScore.toFixed(3)}, answered ${report.answeredRate.toFixed(3)}\n`,
    )

    if (writeBaseline) {
      writeFileSync(writeBaseline, `${JSON.stringify(report, null, 2)}\n`)
      process.stdout.write(`worker: baseline written to ${writeBaseline}\n`)
    }

    if (baselineFile) {
      const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as EvalReport
      const gate = compareToBaseline(baseline, report)
      if (!gate.passed) {
        for (const reason of gate.reasons) process.stderr.write(`worker: ${reason}\n`)
        process.stderr.write('worker: prompt rejected against the baseline\n')
        process.exitCode = 1
        return
      }
      process.stdout.write('worker: prompt accepted against the baseline\n')
    }
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1]?.endsWith('eval.ts') || process.argv[1]?.endsWith('eval.js')) {
  void main()
}
