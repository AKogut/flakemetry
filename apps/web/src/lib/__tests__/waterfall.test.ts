import type { IngestSpan } from '@flakemetry/contracts'
import { describe, expect, it } from 'vitest'

import { buildWaterfall } from '../waterfall'

const base = Date.parse('2026-07-16T10:00:00Z')
const span = (over: Partial<IngestSpan> & { spanId: string; startOffset: number }): IngestSpan => ({
  parentSpanId: null,
  name: over.spanId,
  kind: 'step',
  status: 'ok',
  durationMs: 100,
  attributes: null,
  error: null,
  ...over,
  startedAt: new Date(base + over.startOffset),
})

describe('buildWaterfall', () => {
  it('orders spans depth-first with nesting under the case root', () => {
    const spans: IngestSpan[] = [
      span({ spanId: 's2', parentSpanId: 's1', startOffset: 40, durationMs: 50, kind: 'http' }),
      span({ spanId: 's1', parentSpanId: 'root', startOffset: 20, durationMs: 200 }),
      span({ spanId: 's3', parentSpanId: 'root', startOffset: 300, durationMs: 50 }),
    ]

    const { rows, totalMs } = buildWaterfall(spans, 'root')

    expect(rows.map((row) => row.span.spanId)).toEqual(['s1', 's2', 's3'])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0])
    expect(totalMs).toBe(330)
    expect(rows[0]?.offsetPct).toBeCloseTo(0)
    expect(rows[1]?.offsetPct).toBeCloseTo((20 / 330) * 100)
    expect(rows[1]?.widthPct).toBeCloseTo((50 / 330) * 100)
  })

  it('treats spans whose parent is absent as top level', () => {
    const spans: IngestSpan[] = [
      span({ spanId: 'a', parentSpanId: 'missing', startOffset: 0 }),
      span({ spanId: 'b', parentSpanId: null, startOffset: 10 }),
    ]
    const { rows } = buildWaterfall(spans, 'root')
    expect(rows.map((row) => row.depth)).toEqual([0, 0])
  })

  it('returns an empty waterfall for no spans', () => {
    expect(buildWaterfall([], null)).toEqual({ rows: [], totalMs: 0 })
  })
})
