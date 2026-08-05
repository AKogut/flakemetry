import type { PrismaClient } from '@flakemetry/db'

import { computeIdentityScore } from './scoring'

export type QuarantineDecision = 'quarantined' | 'released' | 'auto'

export const QUARANTINE_DECISIONS: readonly QuarantineDecision[] = [
  'quarantined',
  'released',
  'auto',
]

export const isQuarantineDecision = (value: string): value is QuarantineDecision =>
  (QUARANTINE_DECISIONS as readonly string[]).includes(value)

export const MANUAL_QUARANTINE_REASON = 'manual'
const MAX_REASON_LENGTH = 200

export interface QuarantineState {
  quarantined: boolean
  quarantineOverride: QuarantineDecision | null
  quarantineReason: string | null
}

export interface QuarantineWrite {
  quarantined: boolean
  quarantineOverride: 'quarantined' | 'released' | null
  quarantineReason: string | null
  quarantineOverrideBy: string | null
  quarantineOverrideAt: Date | null
}

/**
 * `auto` hands the test back to the scorer rather than guessing what the scorer would say.
 * The effective state is left where it is and moves on the next run — the cooldown that
 * decides when a quarantined test is safe to release lives in the worker, and a second
 * copy of that rule here would be one that drifts.
 */
export const planQuarantineWrite = (
  current: QuarantineState,
  decision: QuarantineDecision,
  reason: string | null,
  userId: string | null,
  now: Date,
): QuarantineWrite => {
  if (decision === 'auto') {
    return {
      quarantined: current.quarantined,
      quarantineOverride: null,
      quarantineReason: current.quarantineReason,
      quarantineOverrideBy: null,
      quarantineOverrideAt: null,
    }
  }

  const quarantined = decision === 'quarantined'
  const trimmed = (reason ?? '').trim().slice(0, MAX_REASON_LENGTH)

  return {
    quarantined,
    quarantineOverride: decision,
    quarantineReason: quarantined ? trimmed || MANUAL_QUARANTINE_REASON : null,
    quarantineOverrideBy: userId,
    quarantineOverrideAt: now,
  }
}

export type QuarantineOutcome =
  | {
      status: 'applied'
      quarantined: boolean
      override: QuarantineDecision | null
      changed: boolean
    }
  | { status: 'rejected'; reason: string }

export interface SetQuarantineParams {
  orgId: string
  projectId: string
  testIdentityId: string
  decision: QuarantineDecision
  reason?: string | null
  userId?: string | null
  now?: Date
}

/**
 * The real score from the real history, not a placeholder. A test quarantined by hand may
 * be perfectly reliable by measurement, and saying so is more useful than inventing a zero
 * — the badge beside it reads "quarantined" because someone decided, not because it flakes.
 */
const ensureScore = async (
  prisma: PrismaClient,
  orgId: string,
  projectId: string,
  identityId: string,
  now: Date,
): Promise<void> => {
  const existing = await prisma.flakyScore.findUnique({
    where: { testIdentityId: identityId },
    select: { testIdentityId: true },
  })
  if (existing) return

  const scored = await computeIdentityScore(prisma, orgId, projectId, identityId, { now })
  await prisma.flakyScore.create({ data: { testIdentityId: identityId, ...scored.data } })
}

const DETAIL: Record<QuarantineDecision, string> = {
  quarantined: 'quarantined by hand',
  released: 'released by hand',
  auto: 'handed back to the scorer',
}

export const setQuarantine = async (
  prisma: PrismaClient,
  params: SetQuarantineParams,
): Promise<QuarantineOutcome> => {
  const now = params.now ?? new Date()

  // Scoped by project, not just by id: a test id from another tenant must read as absent
  // rather than as something this caller may change.
  const identity = await prisma.testIdentity.findFirst({
    where: { id: params.testIdentityId, projectId: params.projectId },
    select: {
      id: true,
      fingerprint: true,
      quarantined: true,
      quarantineOverride: true,
      quarantineReason: true,
    },
  })
  if (!identity) return { status: 'rejected', reason: 'test not found in this project' }

  const write = planQuarantineWrite(
    {
      quarantined: identity.quarantined,
      quarantineOverride: identity.quarantineOverride,
      quarantineReason: identity.quarantineReason,
    },
    params.decision,
    params.reason ?? null,
    params.userId ?? null,
    now,
  )

  const stateChanged = write.quarantined !== identity.quarantined

  // Until now everything quarantined had been quarantined by the scorer, which writes a
  // score first — so the flaky board, which reads from those scores, could assume one
  // existed. A person quarantining a test the scorer never rated breaks that assumption,
  // and the test they just acted on would be absent from every list in the product.
  if (write.quarantined) await ensureScore(prisma, params.orgId, params.projectId, identity.id, now)

  await prisma.$transaction(async (tx) => {
    await tx.testIdentity.update({ where: { id: identity.id }, data: write })

    // The same kinds the scorer emits, so the quarantine backlog and the health metrics
    // count a person's decision exactly as they count the automation's.
    if (stateChanged) {
      await tx.testHealthEvent.create({
        data: {
          orgId: params.orgId,
          projectId: params.projectId,
          testIdentityId: identity.id,
          kind: write.quarantined ? 'quarantined' : 'unquarantined',
          createdAt: now,
        },
      })
    }

    await tx.identityChange.create({
      data: {
        orgId: params.orgId,
        projectId: params.projectId,
        userId: params.userId ?? null,
        action: `quarantine:${params.decision}`,
        sourceIdentityId: identity.id,
        fingerprint: identity.fingerprint,
        detail: write.quarantineReason
          ? `${DETAIL[params.decision]} — ${write.quarantineReason}`
          : DETAIL[params.decision],
        createdAt: now,
      },
    })
  })

  return {
    status: 'applied',
    quarantined: write.quarantined,
    override: write.quarantineOverride,
    changed: stateChanged || identity.quarantineOverride !== write.quarantineOverride,
  }
}
