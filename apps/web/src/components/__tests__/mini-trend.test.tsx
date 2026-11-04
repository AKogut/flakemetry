import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MiniTrend } from '../mini-trend'

const barsOf = (markup: string): string[] => markup.match(/<rect [^>]*>/g) ?? []
const fillOf = (bar: string | undefined): string | undefined =>
  /fill="([^"]+)"/.exec(bar ?? '')?.[1]

describe('MiniTrend', () => {
  it('does not draw a zero in the tone of the chart', () => {
    const bars = barsOf(
      renderToStaticMarkup(<MiniTrend values={[0, 0.5]} max={1} tone="var(--fail)" />),
    )

    expect(bars).toHaveLength(2)
    expect(fillOf(bars[0])).toBe('var(--border)')
    expect(fillOf(bars[1])).toBe('var(--fail)')
  })

  it('leaves a gap for a day without a value', () => {
    const bars = barsOf(renderToStaticMarkup(<MiniTrend values={[10, null, 30]} />))

    expect(bars).toHaveLength(2)
    expect(bars[0]).toContain('x="132"')
    expect(bars[1]).toContain('x="156"')
  })

  it('keeps a small value visible', () => {
    const bars = barsOf(
      renderToStaticMarkup(<MiniTrend values={[0.001]} max={1} tone="var(--fail)" />),
    )

    expect(fillOf(bars[0])).toBe('var(--fail)')
    expect(bars[0]).toContain('height="2"')
  })

  it('says so when no day has a value', () => {
    expect(renderToStaticMarkup(<MiniTrend values={[null, null]} />)).toContain('No data yet.')
    expect(renderToStaticMarkup(<MiniTrend values={[]} />)).toContain('No data yet.')
  })
})
