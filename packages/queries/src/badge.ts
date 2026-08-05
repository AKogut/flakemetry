import type { PrismaClient } from '@flakemetry/db'

export const BADGE_VARIANTS = ['health', 'flakes', 'quarantined', 'worst'] as const

export type BadgeVariant = (typeof BADGE_VARIANTS)[number]

export const isBadgeVariant = (value: string): value is BadgeVariant =>
  (BADGE_VARIANTS as readonly string[]).includes(value)

export interface BadgeMetrics {
  totalTests: number
  flakyTests: number
  quarantinedTests: number
  flakesThisWeek: number
  worstScore: number
}

export interface Badge {
  label: string
  message: string
  color: string
}

const GREEN = '#3fb950'
const AMBER = '#d29922'
const RED = '#e5534b'
const GREY = '#8b949e'

const band = (value: number, amber: number, red: number): string =>
  value >= red ? RED : value >= amber ? AMBER : GREEN

/**
 * Health is the share of tests that are *not* flagged flaky, so a project with nothing
 * ingested reads as unknown rather than as a perfect score — a green badge earned by having
 * no data would be the most misleading thing this endpoint could produce.
 */
export const toBadge = (variant: BadgeVariant, metrics: BadgeMetrics): Badge => {
  if (variant === 'health') {
    if (metrics.totalTests === 0) return { label: 'flaky health', message: 'no data', color: GREY }
    const healthy = (metrics.totalTests - metrics.flakyTests) / metrics.totalTests
    const percent = Math.round(healthy * 100)
    return {
      label: 'flaky health',
      message: `${percent}%`,
      color: percent >= 98 ? GREEN : percent >= 90 ? AMBER : RED,
    }
  }

  if (variant === 'flakes') {
    return {
      label: 'flakes this week',
      message: String(metrics.flakesThisWeek),
      color: band(metrics.flakesThisWeek, 1, 20),
    }
  }

  if (variant === 'quarantined') {
    return {
      label: 'quarantined',
      message: String(metrics.quarantinedTests),
      color: band(metrics.quarantinedTests, 1, 10),
    }
  }

  if (metrics.totalTests === 0) return { label: 'worst test', message: 'no data', color: GREY }
  return {
    label: 'worst test',
    message: metrics.worstScore.toFixed(2),
    color: band(metrics.worstScore, 0.5, 0.8),
  }
}

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (character) => {
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '&') return '&amp;'
    if (character === "'") return '&apos;'
    return '&quot;'
  })

/** Rough, but the alternative is shipping font metrics for one badge. */
const widthOf = (text: string): number => text.length * 6.5 + 20

/**
 * Rendered here rather than fetched from shields.io: a badge that depends on a third party
 * turns every README that embeds it into a liveness check for someone else's service, and
 * the whole point is that this one reflects data we already hold.
 */
export const renderBadgeSvg = (badge: Badge): string => {
  const labelWidth = Math.round(widthOf(badge.label))
  const messageWidth = Math.round(widthOf(badge.message))
  const total = labelWidth + messageWidth
  const label = escapeXml(badge.label)
  const message = escapeXml(badge.message)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${message}">
<title>${label}: ${message}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${labelWidth}" height="20" fill="#555"/>
<rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${badge.color}"/>
<rect width="${total}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
<text x="${labelWidth / 2}" y="14">${label}</text>
<text x="${labelWidth + messageWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text>
<text x="${labelWidth + messageWidth / 2}" y="14">${message}</text>
</g>
</svg>`
}

/** The schema shields.io consumes, for anyone who would rather render it themselves. */
export const toShieldsJson = (badge: Badge): Record<string, string | number> => ({
  schemaVersion: 1,
  label: badge.label,
  message: badge.message,
  color: badge.color,
})

const WEEK_DAYS = 7

export const getBadgeMetrics = async (
  prisma: PrismaClient,
  projectId: string,
  now: Date = new Date(),
): Promise<BadgeMetrics> => {
  const from = new Date(now)
  from.setUTCHours(0, 0, 0, 0)
  from.setUTCDate(from.getUTCDate() - (WEEK_DAYS - 1))

  // Counts and one rollup aggregate — deliberately nothing that walks raw executions, so a
  // README embedding this cannot put load on the path the dashboard depends on.
  const [totalTests, flakyTests, quarantinedTests, week, worst] = await Promise.all([
    prisma.testIdentity.count({ where: { projectId } }),
    prisma.flakyScore.count({ where: { projectId, quarantineCandidate: true } }),
    prisma.testIdentity.count({ where: { projectId, quarantined: true } }),
    prisma.dailyTestStats.aggregate({
      where: { projectId, day: { gte: from } },
      _sum: { flaky: true },
    }),
    prisma.flakyScore.aggregate({ where: { projectId }, _max: { score: true } }),
  ])

  return {
    totalTests,
    flakyTests,
    quarantinedTests,
    flakesThisWeek: week._sum.flaky ?? 0,
    worstScore: worst._max.score ?? 0,
  }
}
