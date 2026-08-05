import { matchCodeowners, parseCodeowners } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'
import { createGithubTracker, resolveTrackerToken, type TrackerProvider } from '@flakemetry/notify'
import {
  collectTrackerCandidates,
  getEffectiveProjectPolicy,
  planTrackerSync,
  renderTrackerIssue,
  type TrackerAction,
  type TrackerCandidate,
  type TrackerEvidence,
} from '@flakemetry/queries'

export interface TrackerSyncResult {
  opened: number
  reopened: number
  closed: number
  updated: number
  failed: number
}

const empty = (): TrackerSyncResult => ({
  opened: 0,
  reopened: 0,
  closed: 0,
  updated: 0,
  failed: 0,
})

const HISTORY_DAYS = 14

const gatherEvidence = async (
  prisma: PrismaClient,
  projectId: string,
  candidate: TrackerCandidate,
  dashboardUrl: string | null,
): Promise<TrackerEvidence> => {
  const [score, history, execution, owner] = await Promise.all([
    prisma.flakyScore.findUnique({
      where: { testIdentityId: candidate.testIdentityId },
      select: { reasonCodes: true },
    }),
    prisma.dailyTestStats.findMany({
      where: { testIdentityId: candidate.testIdentityId },
      orderBy: { day: 'desc' },
      take: HISTORY_DAYS,
      select: { day: true, flaky: true, total: true },
    }),
    prisma.testExecution.findFirst({
      where: { testIdentityId: candidate.testIdentityId, errorMessage: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: {
        errorMessage: true,
        rcaReport: { select: { summary: true } },
      },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { codeowners: true } }),
  ])

  const owners = owner?.codeowners
    ? matchCodeowners(parseCodeowners(owner.codeowners), candidate.filePath)
    : []

  const reasonCodes = Array.isArray(score?.reasonCodes)
    ? (score.reasonCodes as { code: string; message: string }[])
    : []

  return {
    reasonCodes,
    owner: owners.length > 0 ? owners.join(', ') : null,
    topError: execution?.errorMessage ?? null,
    rcaSummary: execution?.rcaReport?.summary ?? null,
    history: history.reverse(),
    dashboardUrl,
  }
}

const titleOf = (candidate: TrackerCandidate): string =>
  `Flaky test: ${candidate.title}${candidate.suite ? ` (${candidate.suite})` : ''}`

const apply = async (
  prisma: PrismaClient,
  provider: TrackerProvider,
  projectId: string,
  orgId: string,
  action: TrackerAction,
  body: string,
): Promise<keyof TrackerSyncResult> => {
  const { candidate } = action

  if (action.kind === 'open') {
    const ticket = await provider.create({
      title: titleOf(candidate),
      body,
      labels: ['flaky-test'],
    })
    await prisma.trackerIssue.create({
      data: {
        orgId,
        projectId,
        testIdentityId: candidate.testIdentityId,
        provider: provider.name,
        externalId: ticket.externalId,
        url: ticket.url,
        state: 'open',
        lastScore: candidate.score,
      },
    })
    return 'opened'
  }

  if (action.kind === 'reopen') {
    await provider.reopen(
      action.externalId,
      `Flaked again — score is back to **${candidate.score.toFixed(2)}**.\n\n${body}`,
    )
    await prisma.trackerIssue.update({
      where: { testIdentityId: candidate.testIdentityId },
      data: { state: 'open', closedAt: null, lastScore: candidate.score, lastSyncedAt: new Date() },
    })
    return 'reopened'
  }

  if (action.kind === 'close') {
    await provider.close(
      action.externalId,
      `Stable again — closing. Flakemetry will reopen this issue rather than file a new one if it comes back.`,
    )
    await prisma.trackerIssue.update({
      where: { testIdentityId: candidate.testIdentityId },
      data: {
        state: 'closed',
        closedAt: new Date(),
        lastScore: candidate.score,
        lastSyncedAt: new Date(),
      },
    })
    return 'closed'
  }

  await provider.update(action.externalId, body)
  await prisma.trackerIssue.update({
    where: { testIdentityId: candidate.testIdentityId },
    data: { lastScore: candidate.score, lastSyncedAt: new Date() },
  })
  return 'updated'
}

export interface TrackerSyncOptions {
  provider?: TrackerProvider
  env?: Record<string, string | undefined>
  now?: Date
  maxActions?: number
}

/**
 * A sweep rather than an event handler. Persistence is a statement about elapsed time, and
 * nothing fires an event on the day a test has been flaky for long enough — so the check has
 * to run on a clock, and it has to be safe to run repeatedly.
 */
export const syncProjectTracker = async (
  prisma: PrismaClient,
  projectId: string,
  options: TrackerSyncOptions = {},
): Promise<TrackerSyncResult> => {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const result = empty()

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { orgId: true, repository: true },
  })
  if (!project) return result

  const { effective } = await getEffectiveProjectPolicy(prisma, projectId, env)
  if (!effective.trackerEnabled.value) return result

  let provider = options.provider ?? null
  if (!provider) {
    const token = resolveTrackerToken(env)
    if (!token || !project.repository) return result
    provider = createGithubTracker({ repository: project.repository, token })
  }

  const candidates = await collectTrackerCandidates(prisma, projectId)
  const actions = planTrackerSync(
    candidates,
    {
      afterDays: effective.trackerAfterDays.value,
      recoveryDays: effective.trackerRecoveryDays.value,
    },
    now,
  )

  const dashboard = env.FLAKEMETRY_DASHBOARD_URL?.replace(/\/$/, '') ?? null
  const limited = actions.slice(0, options.maxActions ?? 20)

  for (const action of limited) {
    try {
      const evidence = await gatherEvidence(
        prisma,
        projectId,
        action.candidate,
        dashboard
          ? `${dashboard}/projects/${projectId}/tests/${action.candidate.testIdentityId}`
          : null,
      )
      const body = renderTrackerIssue(action.candidate, evidence)
      const outcome = await apply(prisma, provider, projectId, project.orgId, action, body)
      result[outcome] += 1
    } catch (error) {
      // One repository being misconfigured must not stop the rest of the sweep, and a
      // failure here must never leave a row claiming an issue exists when it does not.
      result.failed += 1
      process.stderr.write(
        `worker: tracker sync failed for ${action.candidate.testIdentityId}: ${String(error)}\n`,
      )
    }
  }

  return result
}

export const syncAllTrackers = async (
  prisma: PrismaClient,
  options: TrackerSyncOptions = {},
): Promise<TrackerSyncResult> => {
  const projects = await prisma.project.findMany({ select: { id: true } })
  const total = empty()
  for (const project of projects) {
    const result = await syncProjectTracker(prisma, project.id, options)
    total.opened += result.opened
    total.reopened += result.reopened
    total.closed += result.closed
    total.updated += result.updated
    total.failed += result.failed
  }
  return total
}

const TRACKER_INTERVAL_MS = 60 * 60 * 1000

export const startTrackerSync = (
  prisma: PrismaClient,
  env: Record<string, string | undefined> = process.env,
): void => {
  const sweep = (): void => {
    void syncAllTrackers(prisma, { env })
      .then((result) => {
        const touched = result.opened + result.reopened + result.closed + result.updated
        if (touched > 0) {
          process.stdout.write(
            `worker: tracker opened ${result.opened}, reopened ${result.reopened}, closed ${result.closed}, updated ${result.updated}\n`,
          )
        }
      })
      .catch((error: unknown) => {
        process.stderr.write(`worker: tracker sweep failed ${String(error)}\n`)
      })
  }

  sweep()
  setInterval(sweep, TRACKER_INTERVAL_MS).unref()
}
