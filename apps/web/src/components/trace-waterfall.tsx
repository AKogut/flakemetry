'use client'

import type { IngestSpan } from '@flakemetry/contracts'
import { useState } from 'react'

import { buildWaterfall } from '@/lib/waterfall'

const kindTone: Record<string, string> = {
  step: 'var(--accent)',
  http: '#5aa9e6',
  browser: '#b48ead',
  other: 'var(--muted)',
}

const attributeEntries = (attributes: IngestSpan['attributes']): [string, string][] =>
  attributes ? Object.entries(attributes).map(([key, value]) => [key, String(value)]) : []

const SpanDrawer = ({ span, onClose }: { span: IngestSpan; onClose: () => void }) => {
  const attributes = attributeEntries(span.attributes)
  return (
    <aside className="wf-drawer card">
      <div className="row-between" style={{ marginBottom: '0.6rem' }}>
        <strong className="mono" style={{ wordBreak: 'break-word' }}>
          {span.name}
        </strong>
        <button className="btn btn-secondary" onClick={onClose} aria-label="Close span details">
          ✕
        </button>
      </div>

      <div className="wf-meta">
        <span className="pill" style={{ borderColor: kindTone[span.kind] ?? 'var(--muted)' }}>
          {span.kind}
        </span>
        <span className="muted">{span.durationMs}ms</span>
        <span
          className="muted"
          style={{ color: span.status === 'error' ? 'var(--fail)' : undefined }}
        >
          {span.status}
        </span>
      </div>

      {span.error ? (
        <div className="error-box mono" style={{ marginTop: '0.75rem' }}>
          {span.error.type ? `${span.error.type}: ` : ''}
          {span.error.message}
          {span.error.stack ? `\n\n${span.error.stack}` : ''}
        </div>
      ) : null}

      {attributes.length > 0 ? (
        <table style={{ marginTop: '0.75rem' }}>
          <tbody>
            {attributes.map(([key, value]) => (
              <tr key={key}>
                <td className="mono muted" style={{ verticalAlign: 'top' }}>
                  {key}
                </td>
                <td className="mono" style={{ wordBreak: 'break-word' }}>
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          No attributes recorded.
        </p>
      )}
    </aside>
  )
}

export const TraceWaterfall = ({
  spans,
  rootSpanId,
}: {
  spans: IngestSpan[]
  rootSpanId: string | null
}) => {
  const { rows } = buildWaterfall(spans, rootSpanId)
  const [selected, setSelected] = useState<string | null>(null)

  if (rows.length === 0) {
    return <div className="empty">No spans were recorded for this execution.</div>
  }

  const selectedSpan = rows.find((row) => row.span.spanId === selected)?.span ?? null

  return (
    <div className="wf-layout">
      <div className="waterfall">
        {rows.map((row) => {
          const tone = kindTone[row.span.kind] ?? 'var(--muted)'
          const active = row.span.spanId === selected
          return (
            <button
              key={row.span.spanId}
              className={`wf-row${active ? ' wf-row-active' : ''}`}
              onClick={() => setSelected(active ? null : row.span.spanId)}
            >
              <span
                className="wf-name mono"
                style={{ paddingLeft: `${row.depth * 14}px` }}
                title={row.span.name}
              >
                {row.span.name}
              </span>
              <span className="wf-track">
                <span
                  className="wf-bar"
                  style={{
                    left: `${row.offsetPct}%`,
                    width: `${row.widthPct}%`,
                    background: tone,
                    outline: row.span.status === 'error' ? '2px solid var(--fail)' : undefined,
                  }}
                />
              </span>
              <span className="wf-dur muted">{row.span.durationMs}ms</span>
            </button>
          )
        })}
      </div>

      {selectedSpan ? (
        <SpanDrawer span={selectedSpan} onClose={() => setSelected(null)} />
      ) : (
        <aside className="wf-drawer card">
          <p className="muted" style={{ margin: 0 }}>
            Select a span to see its attributes, timing, and any exception.
          </p>
        </aside>
      )}
    </div>
  )
}
