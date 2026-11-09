import { getPrismaClient } from '@flakemetry/db'
import {
  getTestCaseMatrix,
  type TestCaseCell,
  type TestCaseCoverage,
  type TestCaseRunCounts,
} from '@flakemetry/queries'

import { requireProjectViewer } from '@/lib/viewer'

const prisma = getPrismaClient()

const testCases = (count: number): string => `${count} test case${count === 1 ? '' : 's'}`

const coverageOf = ({ runs, olderRunsLeftOut }: TestCaseCoverage): string => {
  const latest = `Latest ${runs} run${runs === 1 ? '' : 's'}`
  return olderRunsLeftOut
    ? `${latest}. Older runs are not included.`
    : `${latest}, which is all of them.`
}

function RunCounts({ runs }: { runs: TestCaseRunCounts }) {
  if (runs.passed + runs.failed + runs.flaky === 0) {
    return <span className="muted">no runs counted</span>
  }
  return (
    <>
      {runs.failed > 0 ? (
        <div style={{ color: 'var(--fail)', fontWeight: 600 }}>{runs.failed} failed</div>
      ) : null}
      {runs.flaky > 0 ? (
        <div style={{ color: 'var(--flaky)', fontWeight: 600 }}>{runs.flaky} passed on retry</div>
      ) : null}
      {runs.passed > 0 ? <div className="muted">{runs.passed} passed</div> : null}
    </>
  )
}

function VariantCell({
  variant,
  cell,
  base,
}: {
  variant: string
  cell: TestCaseCell | undefined
  base: string
}) {
  if (!cell) {
    return (
      <td className="muted" data-label={variant} style={{ textAlign: 'right' }}>
        —
      </td>
    )
  }
  return (
    <td data-label={variant} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
      {cell.tests.map((test, index) => (
        <a key={test.id} href={`${base}/tests/${test.id}`} title={test.title}>
          {index === 0 ? <RunCounts runs={cell} /> : <span className="muted">+{index} </span>}
        </a>
      ))}
    </td>
  )
}

export default async function TestCasesPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  await requireProjectViewer(projectId)

  const matrix = await getTestCaseMatrix(prisma, projectId)
  const base = `/projects/${projectId}`

  return (
    <>
      <h1 className="page-title">Test cases</h1>
      <p className="page-subtitle">
        One test case across runners and platforms, matched by the id in its title, with the most
        trouble first.
      </p>

      {!matrix.comparable ? (
        <div className="card">
          <div className="empty">
            {matrix.cases.length === 0
              ? 'No test case is on more than one variant yet.'
              : `Found ${testCases(matrix.cases.length)}, each on one variant only.`}{' '}
            Put an id such as <span className="mono">TC-AUTH-001</span> in the title of the test on
            every runner, and give each runner its own variant, for example{' '}
            <span className="mono">FLAKEMETRY_VARIANT=ios</span>. This page fills in once one id
            appears on two variants.
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontWeight: 600, marginBottom: '0.4rem' }}>{coverageOf(matrix.coverage)}</p>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.6rem' }}>
            Each number counts runs, not attempts. A run failed when its last attempt failed, and
            passed on retry when an earlier attempt failed. Failures from runs where most of the
            suite failed together are left out, as they are in the score.
          </p>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="table-stack table-stack-grid">
              <thead>
                <tr>
                  <th>Test case</th>
                  {matrix.variants.map(({ variant }) => (
                    <th
                      key={variant}
                      className="mono"
                      style={{ textAlign: 'right', textTransform: 'none' }}
                    >
                      {variant}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600 }}>All {testCases(matrix.cases.length)}</td>
                  {matrix.variants.map((totals) => (
                    <td
                      key={totals.variant}
                      data-label={totals.variant}
                      style={{ textAlign: 'right', whiteSpace: 'nowrap' }}
                    >
                      <div style={{ fontWeight: 600 }}>{testCases(totals.cases)}</div>
                      <RunCounts runs={totals} />
                    </td>
                  ))}
                </tr>
                {matrix.cases.map((row) => (
                  <tr key={row.caseId}>
                    <td className="mono">{row.caseId}</td>
                    {matrix.variants.map(({ variant }) => (
                      <VariantCell
                        key={variant}
                        variant={variant}
                        cell={row.cells.find((cell) => cell.variant === variant)}
                        base={base}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
