import { getPrismaClient } from '@flakemetry/db'
import { getExecutionTrace, signArtifacts } from '@flakemetry/queries'
import { projectArtifactPrefix, resolveObjectStore } from '@flakemetry/storage'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { TraceWaterfall } from '@/components/trace-waterfall'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const statusTone: Record<string, string> = {
  pass: 'var(--pass)',
  fail: 'var(--fail)',
  flaky: 'var(--flaky)',
  skip: 'var(--skip)',
}

export default async function ExecutionTracePage({
  params,
}: {
  params: Promise<{ projectId: string; testId: string; executionId: string }>
}) {
  const { projectId, testId, executionId } = await params
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const trace = await getExecutionTrace(prisma, projectId, executionId)
  if (!trace || trace.testIdentityId !== testId) notFound()

  const signed = await signArtifacts(resolveObjectStore(process.env), trace.artifacts, {
    keyPrefix: projectArtifactPrefix(trace.orgId, projectId),
  })
  const testBase = `/projects/${projectId}/tests/${testId}`

  return (
    <>
      <div className="row-between">
        <div>
          <p className="page-subtitle" style={{ marginBottom: '0.25rem' }}>
            <Link href={testBase} style={{ color: 'var(--accent)' }}>
              ← {trace.title}
            </Link>
          </p>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Trace
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            <span className="mono">{trace.commitSha.slice(0, 7)}</span> ·{' '}
            <span className="mono muted">{trace.branch}</span> · attempt #{trace.attempt}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: statusTone[trace.status], fontWeight: 600, fontSize: '1.1rem' }}>
            {trace.status}
          </div>
          <div className="muted">{trace.durationMs}ms</div>
          {trace.hasRca ? (
            <Link
              href={`${testBase}?execution=${trace.id}`}
              style={{ color: 'var(--accent)', fontSize: '0.85rem' }}
            >
              View RCA
            </Link>
          ) : null}
        </div>
      </div>

      {trace.errorMessage ? (
        <div className="error-box mono" style={{ marginBottom: '1.25rem' }}>
          {trace.errorMessage}
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
          Span waterfall
        </div>
        <TraceWaterfall spans={trace.spans} rootSpanId={trace.rootSpanId} />
      </div>

      {signed.length > 0 ? (
        <div className="card">
          <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
            Artifacts
          </div>
          <div className="artifact-grid">
            {signed.map((artifact) => (
              <div key={artifact.name} className="artifact">
                {artifact.url && artifact.contentType.startsWith('image/') ? (
                  <a href={artifact.url} target="_blank" rel="noreferrer">
                    <img src={artifact.url} alt={artifact.name} className="artifact-thumb" />
                  </a>
                ) : artifact.url ? (
                  <a href={artifact.url} target="_blank" rel="noreferrer" className="mono">
                    {artifact.name}
                  </a>
                ) : (
                  <span className="mono muted">{artifact.name}</span>
                )}
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  {artifact.contentType}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}
