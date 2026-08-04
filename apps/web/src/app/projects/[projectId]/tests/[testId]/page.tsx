import { matchCodeowners, parseCodeowners } from '@flakemetry/core'
import { getPrismaClient } from '@flakemetry/db'
import {
  findMergeCandidates,
  getClusterImpact,
  getExecutionCluster,
  getParamBuckets,
  getRca,
  getTest,
} from '@flakemetry/queries'
import { notFound } from 'next/navigation'

import { RcaPanel } from '@/components/rca-panel'
import { ReasonCodes, ScoreBadge } from '@/components/score'
import { Sparkline } from '@/components/sparkline'
import {
  mergeTestIdentity,
  splitTestIdentity,
  unmergeTestIdentity,
  updateClusterKnownIssue,
} from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const HISTORY_LIMIT = 60

const statusTone: Record<string, string> = {
  pass: 'var(--pass)',
  fail: 'var(--fail)',
  flaky: 'var(--flaky)',
  skip: 'var(--skip)',
}

const formatWhen = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)

export default async function TestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; testId: string }>
  searchParams: Promise<{ execution?: string; split?: string }>
}) {
  const { projectId, testId } = await params
  const { execution: selectedExecutionId, split: splitError } = await searchParams
  const user = await requireUser()
  const access = await requireProjectAccess(user.id, projectId)
  const canSplit = access.role === 'owner' || access.role === 'admin'

  const test = await getTest(prisma, projectId, testId, HISTORY_LIMIT)
  if (!test) notFound()

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { codeowners: true },
  })
  const owners = project?.codeowners
    ? matchCodeowners(parseCodeowners(project.codeowners), test.filePath)
    : []

  const mergeCandidates = canSplit ? await findMergeCandidates(prisma, projectId, testId) : []
  const paramBuckets = await getParamBuckets(prisma, projectId, testId)

  const timeline = [...test.history].reverse()
  const failures = timeline.filter((point) => point.status === 'fail')
  const selected =
    failures.find((point) => point.executionId === selectedExecutionId) ?? failures[0] ?? null
  const rcaReport = selected ? await getRca(prisma, projectId, selected.executionId) : null
  const cluster = selected ? await getClusterImpact(prisma, projectId, selected.executionId) : null
  const executionCluster = selected
    ? await getExecutionCluster(prisma, projectId, selected.executionId)
    : null

  const base = `/projects/${projectId}/tests/${testId}`

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">{test.title}</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            <span className="mono">{test.suite}</span> ·{' '}
            <span className="mono">{test.filePath}</span>
            {owners.length > 0 ? (
              <>
                {' · '}
                {owners.map((ownerHandle) => (
                  <a
                    key={ownerHandle}
                    href={`/projects/${projectId}/flaky?owner=${encodeURIComponent(ownerHandle)}`}
                    className="mono"
                    style={{ marginRight: '0.4rem' }}
                  >
                    {ownerHandle}
                  </a>
                ))}
              </>
            ) : null}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '1.6rem' }}>
            <ScoreBadge score={test.score} />
          </div>
          {test.quarantined ? <span className="pill pill-quarantined">quarantined</span> : null}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="rca-label">Last {timeline.length} executions</div>
        <Sparkline points={test.history} />
        <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.4rem' }}>
          oldest → newest
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
          Why this score
        </div>
        <ReasonCodes codes={test.reasonCodes} />
      </div>

      {paramBuckets ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="row-between" style={{ marginBottom: '0.6rem' }}>
            <div className="rca-label">Parameterized variants</div>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {paramBuckets.buckets.length} variants ·{' '}
              {Math.round(paramBuckets.totals.passRate * 100)}% pass across{' '}
              {paramBuckets.totals.total.toLocaleString()} executions
            </span>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.6rem' }}>
            This test runs once per parameter set. Each variant keeps its own identity and score, so
            one bad input never drags the others down — the roll-up below shows which one is
            actually failing.
          </p>
          <table>
            <thead>
              <tr>
                <th>Parameters</th>
                <th style={{ textAlign: 'right' }}>Score</th>
                <th style={{ textAlign: 'right' }}>Executions</th>
                <th style={{ textAlign: 'right' }}>Failed</th>
                <th style={{ textAlign: 'right' }}>Flaky</th>
              </tr>
            </thead>
            <tbody>
              {paramBuckets.buckets.map((bucket) => (
                <tr key={bucket.id}>
                  <td className="mono" style={{ fontSize: '0.74rem' }}>
                    {bucket.id === testId ? (
                      <strong>{bucket.label}</strong>
                    ) : (
                      <a href={`/projects/${projectId}/tests/${bucket.id}`}>{bucket.label}</a>
                    )}
                    {bucket.quarantined ? (
                      <span className="pill pill-quarantined" style={{ marginLeft: '0.4rem' }}>
                        quarantined
                      </span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <ScoreBadge score={bucket.score} />
                  </td>
                  <td style={{ textAlign: 'right' }} className="muted">
                    {bucket.total}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      color: bucket.failed > 0 ? 'var(--fail)' : undefined,
                    }}
                  >
                    {bucket.failed}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      color: bucket.flaky > 0 ? 'var(--flaky)' : undefined,
                    }}
                  >
                    {bucket.flaky}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {test.aliases.length > 0 || test.stitches.length > 0 || canSplit ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
            Identity &amp; stitch history
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.6rem' }}>
            This identity keeps its history across {test.aliases.length} prior fingerprint
            {test.aliases.length === 1 ? '' : 's'}. Each stitch links a moved or renamed test so its
            flaky score does not reset — a low-confidence rename is worth auditing.
            {canSplit ? ' Split an over-eager stitch to give it back its own identity.' : ''}
          </p>
          {splitError ? (
            <p style={{ color: 'var(--fail)', fontSize: '0.8rem', marginBottom: '0.6rem' }}>
              Could not apply: {splitError}
            </p>
          ) : null}
          {test.stitches.length === 0 ? (
            <div className="muted">No stitches recorded for this test.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Change</th>
                  <th style={{ textAlign: 'right' }}>Confidence</th>
                  {canSplit ? <th style={{ textAlign: 'right' }}>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {test.stitches.map((stitch, index) => (
                  <tr key={index}>
                    <td className="muted">{formatWhen(stitch.createdAt)}</td>
                    <td>
                      <span className={stitch.level === 'L3' ? 'pill pill-candidate' : 'pill'}>
                        {stitch.level === 'L3'
                          ? 'renamed'
                          : stitch.level === 'manual'
                            ? 'merged'
                            : 'moved'}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: '0.74rem' }}>
                      {stitch.level !== 'L2' && stitch.fromTitle
                        ? `${stitch.fromTitle} → ${stitch.toTitle}`
                        : `${stitch.fromFilePath ?? '—'} → ${stitch.toFilePath}`}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        color:
                          stitch.confidence !== null && stitch.confidence < 0.7
                            ? 'var(--flaky)'
                            : undefined,
                      }}
                    >
                      {stitch.confidence !== null ? `${Math.round(stitch.confidence * 100)}%` : '—'}
                    </td>
                    {canSplit ? (
                      <td style={{ textAlign: 'right' }}>
                        {stitch.level === 'manual' ? (
                          index === 0 ? (
                            <form action={unmergeTestIdentity}>
                              <input type="hidden" name="projectId" value={projectId} />
                              <input type="hidden" name="testId" value={testId} />
                              <button type="submit" className="btn btn-ghost">
                                undo merge
                              </button>
                            </form>
                          ) : (
                            <span className="muted" style={{ fontSize: '0.74rem' }}>
                              undo newer first
                            </span>
                          )
                        ) : index === 0 ? (
                          <form action={splitTestIdentity}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="testId" value={testId} />
                            <input
                              type="hidden"
                              name="fingerprint"
                              value={stitch.fromFingerprint}
                            />
                            <button type="submit" className="btn btn-ghost">
                              split
                            </button>
                          </form>
                        ) : (
                          <span className="muted" style={{ fontSize: '0.74rem' }}>
                            split newer first
                          </span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canSplit && mergeCandidates.length > 0 ? (
            <div
              style={{
                marginTop: '1rem',
                borderTop: '1px solid var(--border)',
                paddingTop: '1rem',
              }}
            >
              <div className="rca-label" style={{ marginBottom: '0.4rem' }}>
                Merge a missed rename
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.6rem' }}>
                If the engine missed a rename and split one test in two, fold the other test&apos;s
                history into this one. The other identity is consumed; this page keeps both
                histories.
              </p>
              <form action={mergeTestIdentity} className="row-between" style={{ gap: '0.6rem' }}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="testId" value={testId} />
                <select name="sourceId" required style={{ flex: 1 }}>
                  <option value="">Choose the test to fold in…</option>
                  {mergeCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title} — {candidate.filePath}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-ghost">
                  merge
                </button>
              </form>
            </div>
          ) : null}
        </div>
      ) : null}

      {selected ? (
        <div style={{ marginBottom: '1.25rem' }}>
          <RcaPanel report={rcaReport} errorMessage={selected.errorMessage} />
        </div>
      ) : null}

      {executionCluster && canSplit ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="row-between" style={{ marginBottom: '0.6rem' }}>
            <strong>Known issue</strong>
            {executionCluster.knownIssueRef ? (
              <span className="mono" style={{ fontSize: '0.8rem' }}>
                {executionCluster.knownIssueRef}
              </span>
            ) : null}
          </div>
          <p className="muted" style={{ marginBottom: '0.6rem' }}>
            Marking this error cluster as a known issue labels every future failure that lands in it
            and skips the cost of analysing it again. Clear the field to undo.
          </p>
          <form action={updateClusterKnownIssue} className="row-between" style={{ gap: '0.5rem' }}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="testId" value={testId} />
            <input type="hidden" name="clusterId" value={executionCluster.clusterId} />
            <input
              className="input mono"
              name="knownIssueRef"
              placeholder="JIRA-123 or a tracker URL"
              defaultValue={executionCluster.knownIssueRef ?? ''}
              style={{ flex: 1 }}
            />
            <button className="btn" type="submit">
              Save
            </button>
          </form>
        </div>
      ) : null}

      {cluster ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="row-between" style={{ marginBottom: '0.6rem' }}>
            <strong>Related failures</strong>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              same error cluster · {cluster.occurrenceCount.toLocaleString()} occurrence
              {cluster.occurrenceCount === 1 ? '' : 's'}
            </span>
          </div>
          <p className="muted" style={{ marginBottom: '0.6rem' }}>
            This failure clusters with {cluster.tests.length} other test
            {cluster.tests.length === 1 ? '' : 's'} — likely one root cause, not{' '}
            {cluster.tests.length === 1 ? 'an isolated' : 'many isolated'} bug
            {cluster.tests.length === 1 ? '' : 's'}.
          </p>
          <ul className="reasons">
            {cluster.tests.map((related) => (
              <li key={related.testIdentityId}>
                <a href={`/projects/${projectId}/tests/${related.testIdentityId}`}>
                  {related.title}
                </a>
                <span className="mono muted" style={{ fontSize: '0.8rem' }}>
                  {' '}
                  · {related.suite} · {related.filePath}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
          Executions
        </div>
        {timeline.length === 0 ? (
          <div className="empty">No executions recorded.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Attempt</th>
                <th>Commit</th>
                <th>Branch</th>
                <th>Duration</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {timeline.map((point) => (
                <tr
                  key={point.executionId}
                  style={
                    selected?.executionId === point.executionId
                      ? { background: 'var(--surface-2)' }
                      : undefined
                  }
                >
                  <td style={{ color: statusTone[point.status], fontWeight: 600 }}>
                    {point.status}
                  </td>
                  <td className="muted">#{point.attempt}</td>
                  <td className="mono">{point.commitSha.slice(0, 7)}</td>
                  <td className="mono muted">{point.branch}</td>
                  <td className="muted">{point.durationMs}ms</td>
                  <td className="muted">{formatWhen(point.startedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {point.status === 'fail' ? (
                      <a
                        href={`${base}?execution=${point.executionId}`}
                        style={{
                          color: 'var(--accent)',
                          fontSize: '0.85rem',
                          marginRight: '0.9rem',
                        }}
                      >
                        {point.hasRca ? 'View RCA' : 'Inspect'}
                      </a>
                    ) : null}
                    <a
                      href={`${base}/executions/${point.executionId}`}
                      style={{ color: 'var(--accent)', fontSize: '0.85rem' }}
                    >
                      Trace
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
