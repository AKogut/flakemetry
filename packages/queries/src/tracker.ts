import type { PrismaClient } from '@flakemetry/db'

export interface TrackerPolicy {
  afterDays: number
  recoveryDays: number
}

export interface TrackerIssueState {
  externalId: string
  url: string
  state: string
  lastScore: number | null
}

export interface TrackerCandidate {
  testIdentityId: string
  title: string
  suite: string
  filePath: string
  score: number
  flaky: boolean
  /** Start of the current unbroken flaky spell, or null when the test is not in one. */
  flakySince: Date | null
  /** When the test last returned to stable, or null when it has not. */
  stableSince: Date | null
  issue: TrackerIssueState | null
}

export type TrackerAction =
  | { kind: 'open'; candidate: TrackerCandidate }
  | { kind: 'reopen'; candidate: TrackerCandidate; externalId: string }
  | { kind: 'close'; candidate: TrackerCandidate; externalId: string }
  | { kind: 'update'; candidate: TrackerCandidate; externalId: string }

const DAY_MS = 24 * 60 * 60 * 1000

/** Below this the score has not moved enough to be worth another comment on the issue. */
const MATERIAL_SCORE_MOVE = 0.05

const daysSince = (from: Date, now: Date): number => (now.getTime() - from.getTime()) / DAY_MS

/**
 * Deliberately pure, and deliberately the only place that decides. A sweep that reasons
 * about tickets while also talking to an API ends up filing duplicates the first time a
 * request half-fails, and duplicates are the failure mode people actually notice.
 *
 * Persistence is measured from the start of the current flaky spell rather than from the
 * last failure: a test that flakes, recovers, and flakes again has not been broken for a
 * week, and filing as though it had would be wrong in the direction of noise.
 */
export const planTrackerSync = (
  candidates: readonly TrackerCandidate[],
  policy: TrackerPolicy,
  now: Date = new Date(),
): TrackerAction[] => {
  const actions: TrackerAction[] = []

  for (const candidate of candidates) {
    const open = candidate.issue?.state === 'open'
    const persistent =
      candidate.flaky &&
      candidate.flakySince !== null &&
      daysSince(candidate.flakySince, now) >= policy.afterDays

    if (persistent) {
      if (!candidate.issue) {
        actions.push({ kind: 'open', candidate })
        continue
      }
      if (!open) {
        actions.push({ kind: 'reopen', candidate, externalId: candidate.issue.externalId })
        continue
      }
      const previous = candidate.issue.lastScore
      if (previous === null || Math.abs(candidate.score - previous) >= MATERIAL_SCORE_MOVE) {
        actions.push({ kind: 'update', candidate, externalId: candidate.issue.externalId })
      }
      continue
    }

    const recovered =
      !candidate.flaky &&
      candidate.stableSince !== null &&
      daysSince(candidate.stableSince, now) >= policy.recoveryDays

    if (recovered && open && candidate.issue) {
      actions.push({ kind: 'close', candidate, externalId: candidate.issue.externalId })
    }
  }

  return actions
}

export interface TrackerEvidence {
  reasonCodes: { code: string; message: string }[]
  owner: string | null
  topError: string | null
  rcaSummary: string | null
  history: { day: Date; flaky: number; total: number }[]
  dashboardUrl: string | null
}

const sparkline = (history: readonly { flaky: number; total: number }[]): string => {
  if (history.length === 0) return ''
  const blocks = '▁▂▃▄▅▆▇█'
  return history
    .map((entry) => {
      const rate = entry.total > 0 ? entry.flaky / entry.total : 0
      const index = Math.min(blocks.length - 1, Math.round(rate * (blocks.length - 1)))
      return blocks[index]
    })
    .join('')
}

export const TRACKER_MARKER = '<!-- flakemetry:tracker -->'

/**
 * The body carries the evidence rather than a link to it, because whoever picks the ticket
 * up should not need an account on the dashboard to know what they are looking at.
 */
export const renderTrackerIssue = (
  candidate: TrackerCandidate,
  evidence: TrackerEvidence,
): string => {
  const lines = [
    TRACKER_MARKER,
    `**${candidate.title}** in \`${candidate.filePath}\` has been flaky since ${candidate.flakySince?.toISOString().slice(0, 10) ?? 'recently'}.`,
    '',
    `| | |`,
    `|---|---|`,
    `| Flaky score | **${candidate.score.toFixed(2)}** |`,
    `| Suite | ${candidate.suite || '—'} |`,
  ]

  if (evidence.owner) lines.push(`| Owner | ${evidence.owner} |`)
  if (evidence.history.length > 0) {
    lines.push(
      `| Flake rate | \`${sparkline(evidence.history)}\` last ${evidence.history.length}d |`,
    )
  }
  lines.push('')

  if (evidence.reasonCodes.length > 0) {
    lines.push('### Why it is scored flaky', '')
    for (const reason of evidence.reasonCodes)
      lines.push(`- **${reason.code}** — ${reason.message}`)
    lines.push('')
  }

  if (evidence.topError) {
    lines.push('### Most common failure', '', '```', evidence.topError.slice(0, 800), '```', '')
  }

  if (evidence.rcaSummary) {
    lines.push('### Suggested cause', '', evidence.rcaSummary, '')
  }

  if (evidence.dashboardUrl) {
    lines.push(`[Open in Flakemetry](${evidence.dashboardUrl})`, '')
  }

  lines.push(
    '<sub>Opened and maintained by Flakemetry. It closes itself when the test stays stable.</sub>',
  )

  return lines.join('\n')
}

export const collectTrackerCandidates = async (
  prisma: PrismaClient,
  projectId: string,
  limit = 200,
): Promise<TrackerCandidate[]> => {
  const scores = await prisma.flakyScore.findMany({
    where: { projectId },
    orderBy: { score: 'desc' },
    take: limit,
    select: {
      testIdentityId: true,
      score: true,
      quarantineCandidate: true,
      identity: {
        select: {
          title: true,
          suite: true,
          filePath: true,
          trackerIssue: {
            select: { externalId: true, url: true, state: true, lastScore: true },
          },
        },
      },
    },
  })
  if (scores.length === 0) return []

  const identityIds = scores.map((row) => row.testIdentityId)
  const events = await prisma.testHealthEvent.findMany({
    where: {
      projectId,
      testIdentityId: { in: identityIds },
      kind: { in: ['flaked', 'stabilized'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { testIdentityId: true, kind: true, createdAt: true },
  })

  const spells = new Map<string, { flakySince: Date | null; stableSince: Date | null }>()
  for (const event of events) {
    const current = spells.get(event.testIdentityId) ?? { flakySince: null, stableSince: null }
    if (event.kind === 'flaked') {
      // Only the first 'flaked' of an unbroken spell counts, so a test that keeps flaking
      // does not reset its own clock and never reaches the threshold.
      if (current.flakySince === null) current.flakySince = event.createdAt
      current.stableSince = null
    } else {
      current.flakySince = null
      current.stableSince = event.createdAt
    }
    spells.set(event.testIdentityId, current)
  }

  return scores.map((row) => ({
    testIdentityId: row.testIdentityId,
    title: row.identity.title,
    suite: row.identity.suite,
    filePath: row.identity.filePath,
    score: row.score,
    flaky: row.quarantineCandidate,
    flakySince: spells.get(row.testIdentityId)?.flakySince ?? null,
    stableSince: spells.get(row.testIdentityId)?.stableSince ?? null,
    issue: row.identity.trackerIssue
      ? {
          externalId: row.identity.trackerIssue.externalId,
          url: row.identity.trackerIssue.url,
          state: row.identity.trackerIssue.state,
          lastScore: row.identity.trackerIssue.lastScore,
        }
      : null,
  }))
}
