import type { ReasonCode, TestStatus } from '@flakemetry/contracts'

export const SCORING_MODEL_VERSION = '0.2.0'

export interface ExecutionPoint {
  status: TestStatus
  commitSha: string
  attempt: number
  startedAt: Date
  runFailureCount?: number
}

export interface ScoringConfig {
  now: Date
  threshold?: number
  minSamples?: number
  halfLifeDays?: number
  priorAlpha?: number
  priorBeta?: number
  windowSize?: number
}

export interface FlakyScoreResult {
  score: number
  flipRate: number
  passOnRerunRate: number
  sameShaVariance: number
  entropy: number
  failIsolation: number
  reasonCodes: ReasonCode[]
  quarantineCandidate: boolean
  modelVersion: string
  sampleSize: number
}

const DEFAULTS = {
  threshold: 0.8,
  minSamples: 5,
  halfLifeDays: 14,
  priorAlpha: 1,
  priorBeta: 1,
  windowSize: 500,
}

const WEIGHTS = {
  sameShaVariance: 0.4,
  instability: 0.2,
  flipRate: 0.15,
  passOnRerunRate: 0.1,
  entropy: 0.1,
  failIsolation: 0.05,
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const isGreen = (status: TestStatus): boolean => status === 'pass' || status === 'flaky'
const isRed = (status: TestStatus): boolean => status === 'fail'

const DAY_MS = 86_400_000

const percent = (value: number): number => Math.round(value * 100)

const computeSameShaVariance = (byCommit: Map<string, TestStatus[]>): number => {
  let multi = 0
  let mixed = 0
  for (const statuses of byCommit.values()) {
    const graded = statuses.filter((status) => status !== 'skip')
    if (graded.length < 2) continue
    multi += 1
    const green = graded.some(isGreen)
    const red = graded.some(isRed)
    if (green && red) mixed += 1
  }
  return multi === 0 ? 0 : mixed / multi
}

const computeFlipRate = (ordered: TestStatus[]): number => {
  const graded = ordered.filter((status) => status !== 'skip')
  if (graded.length < 2) return 0
  let transitions = 0
  for (let i = 1; i < graded.length; i += 1) {
    if (isGreen(graded[i]!) !== isGreen(graded[i - 1]!)) transitions += 1
  }
  return transitions / (graded.length - 1)
}

const computePassOnRerun = (byCommit: Map<string, ExecutionPoint[]>): number => {
  let retriedAfterFail = 0
  let recovered = 0
  for (const points of byCommit.values()) {
    const ordered = [...points].sort((a, b) => a.attempt - b.attempt)
    for (let i = 1; i < ordered.length; i += 1) {
      if (isRed(ordered[i - 1]!.status)) {
        retriedAfterFail += 1
        if (isGreen(ordered[i]!.status)) recovered += 1
      }
    }
  }
  return retriedAfterFail === 0 ? 0 : recovered / retriedAfterFail
}

const computeFailIsolation = (
  points: readonly ExecutionPoint[],
): { ratio: number; failures: number } => {
  const failures = points.filter((point) => isRed(point.status))
  const withContext = failures.filter((point) => point.runFailureCount != null)
  if (withContext.length === 0) return { ratio: 0, failures: failures.length }
  const isolated = withContext.filter((point) => (point.runFailureCount ?? 0) <= 1).length
  return { ratio: isolated / withContext.length, failures: failures.length }
}

const computeEntropy = (green: number, red: number): number => {
  const total = green + red
  if (total === 0) return 0
  const pGreen = green / total
  const pRed = red / total
  const term = (p: number) => (p === 0 ? 0 : -p * Math.log2(p))
  return term(pGreen) + term(pRed)
}

const buildReasonCodes = (signals: {
  passOnRerunRate: number
  sameShaVariance: number
  flipRate: number
  sameShaMixedCommits: number
  failIsolation: number
  failures: number
  sampleSize: number
}): ReasonCode[] => {
  const codes: ReasonCode[] = []
  if (signals.sameShaVariance > 0) {
    codes.push({
      code: 'SAME_SHA_VARIANCE',
      message: `different results on ${signals.sameShaMixedCommits} identical commit(s)`,
    })
  }
  if (signals.passOnRerunRate > 0.2) {
    codes.push({
      code: 'PASS_ON_RERUN',
      message: `passed on rerun in ${percent(signals.passOnRerunRate)}% of retried runs`,
    })
  }
  if (signals.flipRate > 0.3) {
    codes.push({
      code: 'HIGH_FLIP_RATE',
      message: `flipped pass/fail at ${percent(signals.flipRate)}% of run transitions`,
    })
  }
  if (signals.failIsolation > 0.5 && signals.failures >= 2) {
    codes.push({
      code: 'FAIL_ISOLATION',
      message: `failed alone in ${percent(signals.failIsolation)}% of failing runs, pointing at the test not the environment`,
    })
  }
  if (codes.length === 0) {
    codes.push({
      code: 'STABLE',
      message: `no flakiness signals across ${signals.sampleSize} sample(s)`,
    })
  }
  return codes
}

export const computeFlakyScore = (
  history: readonly ExecutionPoint[],
  config: ScoringConfig,
): FlakyScoreResult => {
  const settings = { ...DEFAULTS, ...config }
  const graded = history.filter((point) => point.status !== 'skip')
  const ordered = [...graded]
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .slice(-settings.windowSize)

  const statusByCommit = new Map<string, TestStatus[]>()
  const pointsByCommit = new Map<string, ExecutionPoint[]>()
  for (const point of ordered) {
    const statuses = statusByCommit.get(point.commitSha) ?? []
    statuses.push(point.status)
    statusByCommit.set(point.commitSha, statuses)

    const points = pointsByCommit.get(point.commitSha) ?? []
    points.push(point)
    pointsByCommit.set(point.commitSha, points)
  }

  const sameShaVariance = computeSameShaVariance(statusByCommit)
  const sameShaMixedCommits = [...statusByCommit.values()].filter((statuses) => {
    const g = statuses.filter((s) => s !== 'skip')
    return g.length >= 2 && g.some(isGreen) && g.some(isRed)
  }).length
  const flipRate = computeFlipRate(ordered.map((point) => point.status))
  const passOnRerunRate = computePassOnRerun(pointsByCommit)

  const halfLifeMs = settings.halfLifeDays * DAY_MS
  const decayConstant = Math.LN2 / halfLifeMs
  let alpha = settings.priorAlpha
  let beta = settings.priorBeta
  let greenWeighted = 0
  let redWeighted = 0
  for (const point of ordered) {
    const ageMs = Math.max(0, settings.now.getTime() - point.startedAt.getTime())
    const weight = Math.exp(-decayConstant * ageMs)
    if (isGreen(point.status)) {
      alpha += weight
      greenWeighted += 1
    } else if (isRed(point.status)) {
      beta += weight
      redWeighted += 1
    }
  }

  const stability = alpha / (alpha + beta)
  const instability = 1 - stability
  const entropy = computeEntropy(greenWeighted, redWeighted)
  const { ratio: failIsolation, failures } = computeFailIsolation(ordered)

  const sampleSize = ordered.length

  const score = clamp01(
    WEIGHTS.sameShaVariance * sameShaVariance +
      WEIGHTS.instability * instability +
      WEIGHTS.flipRate * flipRate +
      WEIGHTS.passOnRerunRate * passOnRerunRate +
      WEIGHTS.entropy * entropy +
      WEIGHTS.failIsolation * failIsolation,
  )

  const reasonCodes = buildReasonCodes({
    passOnRerunRate,
    sameShaVariance,
    flipRate,
    sameShaMixedCommits,
    failIsolation,
    failures,
    sampleSize,
  })
  const quarantineCandidate =
    score >= (settings.threshold ?? DEFAULTS.threshold) &&
    sampleSize >= (settings.minSamples ?? DEFAULTS.minSamples)

  return {
    score,
    flipRate,
    passOnRerunRate,
    sameShaVariance,
    entropy,
    failIsolation,
    reasonCodes,
    quarantineCandidate,
    modelVersion: SCORING_MODEL_VERSION,
    sampleSize,
  }
}
