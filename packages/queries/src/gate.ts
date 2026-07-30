import type { PrismaClient, RunStatus } from '@flakemetry/db'

import { getRunSummaryByCommit, type RunSummaryTest } from './summary'

const DAY_MS = 24 * 60 * 60 * 1000

export type GateStrictness = 'off' | 'new' | 'any'
export type GateClassification = 'new_failure' | 'known_flake'
export type GateVerdict = 'pass' | 'block'

export interface GateTest extends RunSummaryTest {
  classification: GateClassification
  baseFailRate: number
  baseSampleSize: number
}

export interface PrGate {
  commitSha: string
  branch: string
  baseBranch: string
  prNumber: number | null
  runStatus: RunStatus
  newFailures: number
  knownFlakes: number
  strictness: GateStrictness
  verdict: GateVerdict
  tests: GateTest[]
}

export interface PrGateOptions {
  baseBranch: string
  windowDays?: number
  knownScore?: number
  strictness?: GateStrictness
  now?: Date
}

const isBad = (status: string): boolean => status === 'fail' || status === 'flaky'

export const getPrGate = async (
  prisma: PrismaClient,
  projectId: string,
  commitSha: string,
  options: PrGateOptions,
): Promise<PrGate | null> => {
  const summary = await getRunSummaryByCommit(prisma, projectId, commitSha)
  if (!summary) return null

  const windowDays = options.windowDays ?? 14
  const knownScore = options.knownScore ?? 0.5
  const strictness = options.strictness ?? 'new'
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - windowDays * DAY_MS)

  const ids = summary.tests.map((test) => test.testIdentityId)
  const baseByIdentity = new Map<string, { total: number; bad: number }>()
  if (ids.length > 0) {
    const grouped = await prisma.testExecution.groupBy({
      by: ['testIdentityId', 'status'],
      where: {
        projectId,
        testIdentityId: { in: ids },
        startedAt: { gte: since },
        run: { branch: options.baseBranch },
      },
      _count: { _all: true },
    })
    for (const row of grouped) {
      const entry = baseByIdentity.get(row.testIdentityId) ?? { total: 0, bad: 0 }
      entry.total += row._count._all
      if (isBad(row.status)) entry.bad += row._count._all
      baseByIdentity.set(row.testIdentityId, entry)
    }
  }

  const tests: GateTest[] = summary.tests.map((test) => {
    const base = baseByIdentity.get(test.testIdentityId) ?? { total: 0, bad: 0 }
    const baseFailRate = base.total > 0 ? base.bad / base.total : 0
    const known = test.quarantined || (test.score ?? 0) >= knownScore || base.bad > 0
    return {
      ...test,
      classification: known ? 'known_flake' : 'new_failure',
      baseFailRate,
      baseSampleSize: base.total,
    }
  })

  const newFailures = tests.filter((test) => test.classification === 'new_failure').length
  const knownFlakes = tests.filter((test) => test.classification === 'known_flake').length
  const blocked =
    strictness === 'any' ? tests.length > 0 : strictness === 'new' ? newFailures > 0 : false

  return {
    commitSha: summary.commitSha,
    branch: summary.branch,
    baseBranch: options.baseBranch,
    prNumber: summary.prNumber,
    runStatus: summary.runStatus,
    newFailures,
    knownFlakes,
    strictness,
    verdict: blocked ? 'block' : 'pass',
    tests,
  }
}

const GATE_COMMENT_MARKER = '<!-- flakemetry:pr-gate -->'

const shortSha = (sha: string): string => sha.slice(0, 7)

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export const renderGateComment = (gate: PrGate): string => {
  const verdict =
    gate.verdict === 'block'
      ? `🚫 **Blocked** — ${gate.newFailures} new failure(s)`
      : gate.newFailures + gate.knownFlakes === 0
        ? '✅ **Passed** — no failing or flaky tests'
        : `✅ **Passed** — ${gate.knownFlakes} known flake(s), no new failures`

  const lines: string[] = [
    GATE_COMMENT_MARKER,
    '',
    '### Flakemetry — PR quality gate',
    '',
    `\`${shortSha(gate.commitSha)}\` on \`${gate.branch}\` vs \`${gate.baseBranch}\` — ${verdict}`,
  ]

  if (gate.tests.length === 0) return lines.join('\n')

  lines.push('', '| Test | In this run | Verdict | On base |', '| --- | --- | --- | --- |')
  for (const test of gate.tests) {
    const label = `\`${escapeCell(test.filePath)}\` › ${escapeCell(test.title)}`
    const state = test.status === 'fail' ? 'failed' : 'flaked'
    const flag = test.classification === 'new_failure' ? '🔴 new failure' : '🟡 known flake'
    const base =
      test.baseSampleSize === 0
        ? 'unseen'
        : `${Math.round(test.baseFailRate * 100)}% of ${test.baseSampleSize}`
    lines.push(`| ${label} | ${state} | ${flag} | ${base} |`)
  }

  return lines.join('\n')
}
