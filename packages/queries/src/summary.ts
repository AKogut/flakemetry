import type { ReasonCode } from '@flakemetry/contracts'
import type { PrismaClient, RunStatus } from '@flakemetry/db'

export interface RunSummaryTest {
  testIdentityId: string
  filePath: string
  suite: string
  title: string
  status: 'fail' | 'flaky'
  errorMessage: string | null
  score: number | null
  quarantined: boolean
  topReason: string | null
  knownIssueRef: string | null
}

export interface RunSummary {
  commitSha: string
  branch: string
  prNumber: number | null
  runStatus: RunStatus
  failed: number
  flaky: number
  tests: RunSummaryTest[]
}

const PR_COMMENT_MARKER = '<!-- flakemetry:pr-comment -->'

interface IdentityRollup {
  filePath: string
  suite: string
  title: string
  quarantined: boolean
  lastStatus: string
  lastAttempt: number
  hasFlaky: boolean
  errorMessage: string | null
  knownIssueRef: string | null
}

export const getRunSummaryByCommit = async (
  prisma: PrismaClient,
  projectId: string,
  commitSha: string,
): Promise<RunSummary | null> => {
  const run = await prisma.run.findFirst({
    where: { projectId, commitSha },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, commitSha: true, branch: true, prNumber: true, status: true },
  })
  if (!run) return null

  const executions = await prisma.testExecution.findMany({
    where: { runId: run.id, projectId },
    orderBy: [{ attempt: 'asc' }],
    select: {
      testIdentityId: true,
      status: true,
      attempt: true,
      errorMessage: true,
      identity: { select: { filePath: true, suite: true, title: true, quarantined: true } },
      errorSignature: { select: { cluster: { select: { knownIssueRef: true } } } },
    },
  })

  const rollups = new Map<string, IdentityRollup>()
  for (const execution of executions) {
    const current = rollups.get(execution.testIdentityId)
    if (!current) {
      rollups.set(execution.testIdentityId, {
        filePath: execution.identity.filePath,
        suite: execution.identity.suite,
        title: execution.identity.title,
        quarantined: execution.identity.quarantined,
        lastStatus: execution.status,
        lastAttempt: execution.attempt,
        hasFlaky: execution.status === 'flaky',
        errorMessage: execution.status === 'fail' ? execution.errorMessage : null,
        knownIssueRef: execution.errorSignature?.cluster?.knownIssueRef ?? null,
      })
      continue
    }
    current.knownIssueRef ??= execution.errorSignature?.cluster?.knownIssueRef ?? null
    if (execution.status === 'flaky') current.hasFlaky = true
    if (execution.attempt >= current.lastAttempt) {
      current.lastAttempt = execution.attempt
      current.lastStatus = execution.status
    }
    if (execution.status === 'fail') current.errorMessage = execution.errorMessage
  }

  const notable: { id: string; status: 'fail' | 'flaky'; rollup: IdentityRollup }[] = []
  for (const [id, rollup] of rollups) {
    if (rollup.hasFlaky) notable.push({ id, status: 'flaky', rollup })
    else if (rollup.lastStatus === 'fail') notable.push({ id, status: 'fail', rollup })
  }

  const scores =
    notable.length > 0
      ? await prisma.flakyScore.findMany({
          where: { projectId, testIdentityId: { in: notable.map((item) => item.id) } },
          select: { testIdentityId: true, score: true, reasonCodes: true },
        })
      : []
  const scoreById = new Map(scores.map((row) => [row.testIdentityId, row]))

  const tests: RunSummaryTest[] = notable.map(({ id, status, rollup }) => {
    const score = scoreById.get(id)
    const reasons = (score?.reasonCodes ?? []) as ReasonCode[]
    return {
      testIdentityId: id,
      filePath: rollup.filePath,
      suite: rollup.suite,
      title: rollup.title,
      status,
      errorMessage: rollup.errorMessage,
      score: score?.score ?? null,
      quarantined: rollup.quarantined,
      topReason: reasons[0]?.message ?? null,
      knownIssueRef: rollup.knownIssueRef,
    }
  })

  tests.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'fail' ? -1 : 1
    return (b.score ?? 0) - (a.score ?? 0)
  })

  return {
    commitSha: run.commitSha,
    branch: run.branch,
    prNumber: run.prNumber,
    runStatus: run.status,
    failed: tests.filter((test) => test.status === 'fail').length,
    flaky: tests.filter((test) => test.status === 'flaky').length,
    tests,
  }
}

const shortSha = (sha: string): string => sha.slice(0, 7)

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export const renderPrComment = (summary: RunSummary): string => {
  const lines: string[] = [PR_COMMENT_MARKER, '', '### Flakemetry — test report', '']

  if (summary.tests.length === 0) {
    lines.push(
      `No flaky or failing tests in \`${shortSha(summary.commitSha)}\` on \`${summary.branch}\`.`,
    )
    return lines.join('\n')
  }

  const parts: string[] = []
  if (summary.failed > 0) parts.push(`**${summary.failed} failed**`)
  if (summary.flaky > 0) parts.push(`${summary.flaky} flaky`)
  lines.push(
    `\`${shortSha(summary.commitSha)}\` on \`${summary.branch}\` — ${parts.join(' · ')}`,
    '',
    '| Test | In this run | Flaky score |',
    '| --- | --- | --- |',
  )

  for (const test of summary.tests) {
    const label = `\`${escapeCell(test.filePath)}\` › ${escapeCell(test.title)}`
    const state = test.status === 'fail' ? 'failed' : 'flaked'
    const score =
      test.score === null ? '—' : `${test.score.toFixed(2)}${test.quarantined ? ' 🔒' : ''}`
    const known = test.knownIssueRef ? ` · known issue ${escapeCell(test.knownIssueRef)}` : ''
    lines.push(`| ${label} | ${state}${known} | ${score} |`)
  }

  const reasoned = summary.tests.find((test) => test.topReason)
  if (reasoned?.topReason) {
    lines.push('', `<sub>Why: ${escapeCell(reasoned.topReason)}</sub>`)
  }

  return lines.join('\n')
}
