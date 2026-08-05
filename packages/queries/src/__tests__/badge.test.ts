import { describe, expect, it } from 'vitest'

import { type BadgeMetrics, isBadgeVariant, renderBadgeSvg, toBadge, toShieldsJson } from '../badge'

const metrics = (over: Partial<BadgeMetrics> = {}): BadgeMetrics => ({
  totalTests: 100,
  flakyTests: 1,
  quarantinedTests: 0,
  flakesThisWeek: 3,
  worstScore: 0.42,
  ...over,
})

describe('toBadge', () => {
  it('reads an empty project as unknown, not as perfect', () => {
    const badge = toBadge('health', metrics({ totalTests: 0, flakyTests: 0 }))

    // A green badge earned by having no data is the most misleading thing this can produce.
    expect(badge.message).toBe('no data')
    expect(badge.color).toBe('#8b949e')
  })

  it('turns amber and then red as flaky share grows', () => {
    expect(toBadge('health', metrics({ totalTests: 100, flakyTests: 1 })).color).toBe('#3fb950')
    expect(toBadge('health', metrics({ totalTests: 100, flakyTests: 5 })).color).toBe('#d29922')
    expect(toBadge('health', metrics({ totalTests: 100, flakyTests: 30 })).color).toBe('#e5534b')
  })

  it('is green only when nothing flaked this week', () => {
    expect(toBadge('flakes', metrics({ flakesThisWeek: 0 })).color).toBe('#3fb950')
    expect(toBadge('flakes', metrics({ flakesThisWeek: 1 })).color).toBe('#d29922')
    expect(toBadge('flakes', metrics({ flakesThisWeek: 50 })).color).toBe('#e5534b')
  })

  it('reports quarantined count and worst score', () => {
    expect(toBadge('quarantined', metrics({ quarantinedTests: 4 })).message).toBe('4')
    expect(toBadge('worst', metrics({ worstScore: 0.87 })).message).toBe('0.87')
    expect(toBadge('worst', metrics({ worstScore: 0.87 })).color).toBe('#e5534b')
  })

  it('says no data for the worst test when there are none', () => {
    expect(toBadge('worst', metrics({ totalTests: 0 })).message).toBe('no data')
  })
})

describe('isBadgeVariant', () => {
  it('accepts only the variants that exist', () => {
    expect(isBadgeVariant('health')).toBe(true)
    expect(isBadgeVariant('worst')).toBe(true)
    expect(isBadgeVariant('../../etc/passwd')).toBe(false)
    expect(isBadgeVariant('')).toBe(false)
  })
})

describe('renderBadgeSvg', () => {
  it('renders valid svg carrying the message', () => {
    const svg = renderBadgeSvg({ label: 'flaky health', message: '98%', color: '#3fb950' })

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('98%')
    expect(svg).toContain('#3fb950')
  })

  it('escapes text rather than letting it close a tag', () => {
    const svg = renderBadgeSvg({
      label: '<script>alert(1)</script>',
      message: 'x" onload="y',
      color: '#000',
    })

    // The label is derived in-process today, but an SVG that trusts its inputs is one
    // refactor away from being served attacker-controlled text.
    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('onload="y')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('gives an accessible label', () => {
    const svg = renderBadgeSvg({ label: 'flaky health', message: '98%', color: '#3fb950' })

    expect(svg).toContain('aria-label="flaky health: 98%"')
    expect(svg).toContain('<title>flaky health: 98%</title>')
  })
})

describe('toShieldsJson', () => {
  it('emits the schema shields consumes', () => {
    expect(toShieldsJson({ label: 'flaky health', message: '98%', color: '#3fb950' })).toEqual({
      schemaVersion: 1,
      label: 'flaky health',
      message: '98%',
      color: '#3fb950',
    })
  })
})
