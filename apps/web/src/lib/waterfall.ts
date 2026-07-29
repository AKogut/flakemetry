import type { IngestSpan } from '@flakemetry/contracts'

export interface WaterfallRow {
  span: IngestSpan
  depth: number
  offsetPct: number
  widthPct: number
}

export interface Waterfall {
  rows: WaterfallRow[]
  totalMs: number
}

const startMs = (span: IngestSpan): number => new Date(span.startedAt).getTime()

export const buildWaterfall = (
  spans: readonly IngestSpan[],
  rootSpanId: string | null,
): Waterfall => {
  if (spans.length === 0) return { rows: [], totalMs: 0 }

  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const childrenByParent = new Map<string | null, IngestSpan[]>()
  for (const span of spans) {
    const hasRealParent =
      Boolean(span.parentSpanId) &&
      span.parentSpanId !== rootSpanId &&
      byId.has(span.parentSpanId as string)
    const parent = hasRealParent ? (span.parentSpanId as string) : null
    const siblings = childrenByParent.get(parent)
    if (siblings) siblings.push(span)
    else childrenByParent.set(parent, [span])
  }

  const traceStart = Math.min(...spans.map(startMs))
  const traceEnd = Math.max(...spans.map((span) => startMs(span) + span.durationMs))
  const totalMs = Math.max(1, traceEnd - traceStart)

  const rows: WaterfallRow[] = []
  const visited = new Set<string>()
  const walk = (parent: string | null, depth: number): void => {
    const children = [...(childrenByParent.get(parent) ?? [])].sort(
      (a, b) => startMs(a) - startMs(b),
    )
    for (const span of children) {
      if (visited.has(span.spanId)) continue
      visited.add(span.spanId)
      rows.push({
        span,
        depth,
        offsetPct: ((startMs(span) - traceStart) / totalMs) * 100,
        widthPct: Math.max((span.durationMs / totalMs) * 100, 0.75),
      })
      walk(span.spanId, depth + 1)
    }
  }
  walk(null, 0)

  return { rows, totalMs }
}
