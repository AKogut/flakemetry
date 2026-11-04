import { randomUUID } from 'node:crypto'

import {
  countStatuses,
  createPrismaAdapter,
  createPrismaClient,
  type Prisma,
  PrismaClient,
  runCountFields,
} from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import {
  getTestCaseMatrix,
  hasTestCaseComparison,
  TEST_CASE_EXECUTION_LIMIT,
  TEST_CASE_RUN_LIMIT,
  type TestCaseMatrix,
} from '../test-cases'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()
const NOW = new Date('2026-10-01T12:00:00Z')

type Status = 'pass' | 'fail' | 'flaky' | 'skip'
type Attempts = readonly (readonly [testId: string, status: Status, attempt?: number])[]

const seedProject = async () => {
  const slug = `cases-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  const tenant = { orgId: org.id, projectId: project.id }
  let tests = 0
  let runs = 0

  const addTest = async (
    title: string,
    params: Prisma.InputJsonValue | undefined,
    lastSeenAt = NOW,
  ): Promise<string> => {
    tests += 1
    const identity = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: `fp-${tests}-${slug}`,
        filePath: 'e2e/app.spec.ts',
        suite: 'app',
        title,
        ...(params === undefined ? {} : { params }),
        firstSeenAt: NOW,
        lastSeenAt,
      },
    })
    return identity.id
  }

  const addRun = async (
    attempts: Attempts,
    storedExecutions = attempts.length,
  ): Promise<string> => {
    runs += 1
    const startedAt = new Date(NOW.getTime() + runs * 60_000)
    const run = await prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: `run-${runs}-${slug}`,
        commitSha: `sha-${runs}`,
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'schedule',
        status: attempts.some(([, status]) => status === 'fail') ? 'failed' : 'passed',
        startedAt,
        ...runCountFields(countStatuses(attempts.map(([, status]) => status))),
        storedExecutions,
      },
    })
    await prisma.testExecution.createMany({
      data: attempts.map(([testIdentityId, status, attempt = 1], ordinal) => ({
        ...tenant,
        runId: run.id,
        testIdentityId,
        ordinal,
        status,
        attempt,
        durationMs: 10,
        startedAt,
      })),
    })
    return run.id
  }

  const addPassingRuns = async (count: number, testIds: string[]): Promise<void> => {
    const batch = `${slug}-${runs}`
    const firstMinute = runs
    runs += count
    await prisma.$executeRaw`
      WITH new_run AS (
        INSERT INTO run (id, org_id, project_id, idempotency_key, commit_sha, branch, ci_provider,
                         trigger, status, started_at, passed_count, stored_executions)
        SELECT gen_random_uuid(), ${tenant.orgId}::uuid, ${tenant.projectId}::uuid,
               ${batch} || '-' || n, 'sha', 'main', 'github_actions', 'schedule', 'passed',
               TIMESTAMP '2027-01-01' + make_interval(mins => ${firstMinute}::int + n),
               ${testIds.length}::int, ${testIds.length}::int
        FROM generate_series(1, ${count}::int) AS n
        RETURNING id, started_at
      )
      INSERT INTO test_execution (id, org_id, project_id, run_id, test_identity_id, ordinal,
                                  attempt, status, duration_ms, started_at)
      SELECT gen_random_uuid(), ${tenant.orgId}::uuid, ${tenant.projectId}::uuid, new_run.id,
             test.id, test.ordinal, 1, 'pass', 10, new_run.started_at
      FROM new_run
      CROSS JOIN unnest(${testIds}::uuid[]) WITH ORDINALITY AS test(id, ordinal)
    `
  }

  return { ...tenant, addTest, addRun, addPassingRuns }
}

const variant = (name: string) => ({ variant: name })

const cellOf = (matrix: TestCaseMatrix, caseId: string, variantName: string) =>
  matrix.cases
    .find((row) => row.caseId === caseId)
    ?.cells.find((cell) => cell.variant === variantName)

describe.skipIf(!hasDb)('test cases across variants', { timeout: 120_000 }, () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reads one test case from the naming of every runner', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const appium = await addTest('TC-AUTH-001 — Successful login', variant('appium-android'))
    const xcuitest = await addTest('test_TC_AUTH_001_validLogin', variant('xcuitest'))
    const espresso = await addTest('TC_AUTH_001_successfulLogin', variant('espresso'))
    const camelCase = await addTest('testTC_AUTH_001_validLogin', variant('swift'))
    const lowerCase = await addTest('test_tc_auth_001_valid_login', variant('pytest'))
    await addRun([
      [appium, 'pass'],
      [xcuitest, 'pass'],
      [espresso, 'fail'],
      [camelCase, 'pass'],
      [lowerCase, 'flaky'],
    ])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(matrix.comparable).toBe(true)
    expect(matrix.cases.map((row) => row.caseId)).toEqual(['TC-AUTH-001'])
    expect(matrix.cases[0]?.cells.map((cell) => cell.variant)).toEqual([
      'appium-android',
      'espresso',
      'pytest',
      'swift',
      'xcuitest',
    ])
    expect(cellOf(matrix, 'TC-AUTH-001', 'espresso')).toMatchObject({
      passed: 0,
      failed: 1,
      flaky: 0,
      tests: [{ id: espresso, title: 'TC_AUTH_001_successfulLogin' }],
    })
    expect(cellOf(matrix, 'TC-AUTH-001', 'appium-android')).toMatchObject({ passed: 1, failed: 0 })
    expect(cellOf(matrix, 'TC-AUTH-001', 'pytest')).toMatchObject({ passed: 0, flaky: 1 })
  })

  it('counts runs, not attempts', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const test = await addTest('TC-AUTH-001', variant('ios'))

    await addRun([
      [test, 'fail', 1],
      [test, 'fail', 2],
    ])
    await addRun([
      [test, 'pass', 1],
      [test, 'pass', 2],
    ])
    await addRun([
      [test, 'fail', 1],
      [test, 'flaky', 2],
    ])
    await addRun([
      [test, 'fail', 1],
      [test, 'pass', 2],
    ])
    await addRun([[test, 'flaky', 2]])
    await addRun([
      [test, 'pass', 1],
      [test, 'fail', 2],
    ])
    await addRun([[test, 'skip']])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({ passed: 1, failed: 2, flaky: 3 })
  })

  it('reads the last attempt whatever order the rows arrived in', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const test = await addTest('TC-AUTH-001', variant('ios'))

    await addRun([
      [test, 'flaky', 2],
      [test, 'fail', 1],
    ])
    await addRun([
      [test, 'fail', 2],
      [test, 'pass', 1],
    ])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({ passed: 0, failed: 1, flaky: 1 })
  })

  describe('a run where most of the suite failed', () => {
    const seedMassFailure = async () => {
      const project = await seedProject()
      const crashed = await project.addTest('TC-AUTH-001', variant('ios'))
      const survived = await project.addTest('TC-AUTH-002', variant('ios'))
      const recovered = await project.addTest('TC-AUTH-003', variant('ios'))
      const recoveredByPass = await project.addTest('TC-AUTH-004', variant('ios'))
      const others = await Promise.all(
        [1, 2, 3].map((index) => project.addTest(`no id here ${index}`, variant('ios'))),
      )
      await project.addRun([
        [crashed, 'fail', 1],
        [crashed, 'fail', 2],
        [survived, 'pass'],
        [recovered, 'fail', 1],
        [recovered, 'flaky', 2],
        [recoveredByPass, 'fail', 1],
        [recoveredByPass, 'pass', 2],
        ...others.map((id) => [id, 'fail'] as const),
      ])
      return { ...project, crashed, survived, recovered, recoveredByPass }
    }

    it('leaves out its failures, as the score does, and keeps everything else', async () => {
      const { projectId } = await seedMassFailure()

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({
        passed: 0,
        failed: 0,
        flaky: 0,
      })
      expect(cellOf(matrix, 'TC-AUTH-002', 'ios')).toMatchObject({ passed: 1, failed: 0 })
      expect(cellOf(matrix, 'TC-AUTH-003', 'ios')).toMatchObject({ failed: 0, flaky: 1 })
      expect(cellOf(matrix, 'TC-AUTH-004', 'ios')).toMatchObject({
        passed: 1,
        failed: 0,
        flaky: 0,
      })
    })

    it('still counts a failure of the same test in an ordinary run', async () => {
      const { projectId, addRun, crashed, survived } = await seedMassFailure()
      await addRun([
        [crashed, 'fail'],
        [survived, 'pass'],
      ])

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({ failed: 1 })
    })

    it('counts failing tests rather than attempts, so retries cannot make one up', async () => {
      const { projectId, addTest, addRun } = await seedProject()
      const tests = await Promise.all(
        ['001', '002', '003', '004'].map((id) => addTest(`TC-AUTH-${id}`, variant('ios'))),
      )
      await addRun(
        tests.flatMap((test) => [1, 2, 3].map((attempt) => [test, 'fail', attempt] as const)),
      )

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({ failed: 1 })
    })

    it('needs at least half of the run failing', async () => {
      const { projectId, addTest, addRun } = await seedProject()
      const tests = await Promise.all(
        Array.from({ length: 11 }, (_, index) => addTest(`TC-AUTH-${index + 1}`, variant('ios'))),
      )
      await addRun(tests.map((test, index) => [test, index < 5 ? 'fail' : 'pass'] as const))

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(cellOf(matrix, 'TC-AUTH-1', 'ios')).toMatchObject({ failed: 1 })
    })
  })

  it('counts a run once when one variant has two tests for a case, and the worst wins', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const older = await addTest(
      'TC-AUTH-001 old name',
      variant('ios'),
      new Date('2026-09-01T00:00:00Z'),
    )
    const newer = await addTest('TC-AUTH-001 new name', variant('ios'))

    await addRun([
      [older, 'pass'],
      [newer, 'pass'],
    ])
    await addRun([
      [older, 'pass'],
      [newer, 'fail'],
    ])
    await addRun([
      [older, 'pass'],
      [newer, 'flaky'],
    ])
    await addRun([
      [older, 'fail'],
      [newer, 'flaky'],
    ])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(matrix.comparable).toBe(false)
    expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toEqual({
      variant: 'ios',
      passed: 1,
      failed: 2,
      flaky: 1,
      tests: [
        { id: newer, title: 'TC-AUTH-001 new name' },
        { id: older, title: 'TC-AUTH-001 old name' },
      ],
    })
  })

  it('leaves out a test with no id or no usable variant', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const included = await addTest('TC-AUTH-001', variant('ios'))
    const excluded = await Promise.all([
      addTest('logs in', variant('ios')),
      addTest('ETC-AUTH-001', variant('android')),
      addTest('TC-AUTH-001', undefined),
      addTest('TC-AUTH-001', { browser: 'webkit' }),
      addTest('TC-AUTH-001', { variant: '' }),
      addTest('TC-AUTH-001', { variant: 42 }),
    ])
    await addRun([[included, 'pass'], ...excluded.map((id) => [id, 'fail'] as const)])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(matrix.variants.map((total) => total.variant)).toEqual(['ios'])
    expect(matrix.cases.map((row) => row.caseId)).toEqual(['TC-AUTH-001'])
    expect(cellOf(matrix, 'TC-AUTH-001', 'ios')?.tests).toEqual([
      { id: included, title: 'TC-AUTH-001' },
    ])
  })

  it('keeps a test that has only been skipped, with nothing counted', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const skipped = await addTest('TC-AUTH-001', variant('ios'))
    const neverRun = await addTest('TC-AUTH-001', variant('android'))
    await addRun([[skipped, 'skip']])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toEqual({
      variant: 'ios',
      passed: 0,
      failed: 0,
      flaky: 0,
      tests: [{ id: skipped, title: 'TC-AUTH-001' }],
    })
    expect(cellOf(matrix, 'TC-AUTH-001', 'android')?.tests[0]?.id).toBe(neverRun)
  })

  it('puts the most trouble first, then orders ids by their number', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const clean10 = await addTest('TC-AUTH-10', variant('ios'))
    const clean9 = await addTest('TC-AUTH-9', variant('ios'))
    const flakyOnBoth = await addTest('TC-AUTH-1', variant('ios'))
    const flakyOnBothOther = await addTest('TC_AUTH_1', variant('android'))
    const failedOnce = await addTest('TC-AUTH-2', variant('android'))

    await addRun([
      [clean10, 'pass'],
      [clean9, 'pass'],
      [flakyOnBoth, 'flaky', 2],
      [flakyOnBothOther, 'flaky', 2],
      [failedOnce, 'fail'],
    ])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(matrix.cases.map((row) => [row.caseId, row.trouble])).toEqual([
      ['TC-AUTH-1', 2],
      ['TC-AUTH-2', 1],
      ['TC-AUTH-9', 0],
      ['TC-AUTH-10', 0],
    ])
  })

  it('adds up each variant', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const iosLogin = await addTest('TC-AUTH-001', variant('ios'))
    const iosLogout = await addTest('TC-AUTH-002', variant('ios'))
    const androidLogin = await addTest('TC-AUTH-001', variant('android'))

    await addRun([
      [iosLogin, 'pass'],
      [iosLogout, 'fail'],
    ])
    await addRun([
      [iosLogin, 'flaky', 2],
      [iosLogout, 'pass'],
    ])
    await addRun([[androidLogin, 'pass']])

    const matrix = await getTestCaseMatrix(prisma, projectId)

    expect(matrix.variants).toEqual([
      { variant: 'android', passed: 1, failed: 0, flaky: 0, cases: 1 },
      { variant: 'ios', passed: 2, failed: 1, flaky: 1, cases: 2 },
    ])
  })

  it('returns nothing for a project with no test cases', async () => {
    const { projectId, addTest, addRun } = await seedProject()
    const test = await addTest('logs in', variant('ios'))
    await addRun([[test, 'fail']])

    expect(await getTestCaseMatrix(prisma, projectId)).toEqual({
      variants: [],
      cases: [],
      comparable: false,
      coverage: { runs: 0, olderRunsLeftOut: false },
    })
  })

  describe('how far back it reads', () => {
    it('covers every run when they all fit, and says so', async () => {
      const { projectId, addTest, addRun } = await seedProject()
      const test = await addTest('TC-AUTH-001', variant('ios'))
      await addRun([[test, 'fail']])
      await addRun([[test, 'pass']])

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(matrix.coverage).toEqual({ runs: 2, olderRunsLeftOut: false })
      expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({ passed: 1, failed: 1 })
    })

    it('stops at the run limit and says older runs are left out', async () => {
      const { projectId, addTest, addRun, addPassingRuns } = await seedProject()
      const test = await addTest('TC-AUTH-001', variant('ios'))
      await addRun([[test, 'fail']])
      await addPassingRuns(TEST_CASE_RUN_LIMIT - 1, [test])

      const atTheLimit = await getTestCaseMatrix(prisma, projectId)

      expect(atTheLimit.coverage).toEqual({ runs: TEST_CASE_RUN_LIMIT, olderRunsLeftOut: false })
      expect(cellOf(atTheLimit, 'TC-AUTH-001', 'ios')).toMatchObject({
        passed: TEST_CASE_RUN_LIMIT - 1,
        failed: 1,
      })

      await addPassingRuns(1, [test])

      const pastTheLimit = await getTestCaseMatrix(prisma, projectId)

      expect(pastTheLimit.coverage).toEqual({ runs: TEST_CASE_RUN_LIMIT, olderRunsLeftOut: true })
      expect(cellOf(pastTheLimit, 'TC-AUTH-001', 'ios')).toMatchObject({
        passed: TEST_CASE_RUN_LIMIT,
        failed: 0,
      })
    })

    it('stops earlier when the runs hold too many executions to read', async () => {
      const { projectId, addTest, addRun } = await seedProject()
      const test = await addTest('TC-AUTH-001', variant('ios'))
      const half = TEST_CASE_EXECUTION_LIMIT / 2
      await addRun([[test, 'fail']], half)
      await addRun([[test, 'pass']], half)
      expect((await getTestCaseMatrix(prisma, projectId)).coverage).toEqual({
        runs: 2,
        olderRunsLeftOut: false,
      })

      await addRun([[test, 'flaky', 2]], half)

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(matrix.coverage).toEqual({ runs: 2, olderRunsLeftOut: true })
      expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({
        passed: 1,
        failed: 0,
        flaky: 1,
      })
    })

    it('always reads the latest run, however large', async () => {
      const { projectId, addTest, addRun } = await seedProject()
      const test = await addTest('TC-AUTH-001', variant('ios'))
      await addRun([[test, 'fail']])
      await addRun([[test, 'pass']], TEST_CASE_EXECUTION_LIMIT + 1)

      const matrix = await getTestCaseMatrix(prisma, projectId)

      expect(matrix.coverage).toEqual({ runs: 1, olderRunsLeftOut: true })
      expect(cellOf(matrix, 'TC-AUTH-001', 'ios')).toMatchObject({ passed: 1, failed: 0 })
    })
  })

  describe('hasTestCaseComparison', () => {
    it('is false until one id is on two variants', async () => {
      const { projectId, addTest } = await seedProject()
      expect(await hasTestCaseComparison(prisma, projectId)).toBe(false)

      await addTest('logs in', variant('ios'))
      await addTest('logs in', variant('android'))
      expect(await hasTestCaseComparison(prisma, projectId)).toBe(false)

      await addTest('TC-AUTH-001', undefined)
      await addTest('TC-AUTH-001 first name', variant('ios'))
      await addTest('TC-AUTH-001 second name', variant('ios'))
      await addTest('TC-AUTH-002', variant('android'))
      expect(await hasTestCaseComparison(prisma, projectId)).toBe(false)

      await addTest('test_TC_AUTH_001_validLogin', variant('android'))
      expect(await hasTestCaseComparison(prisma, projectId)).toBe(true)
    })

    it('agrees with the page', async () => {
      const { projectId, addTest } = await seedProject()
      await addTest('TC-AUTH-001', variant('ios'))
      expect((await getTestCaseMatrix(prisma, projectId)).comparable).toBe(false)

      await addTest('TC_AUTH_001', variant('android'))
      expect((await getTestCaseMatrix(prisma, projectId)).comparable).toBe(true)
      expect(await hasTestCaseComparison(prisma, projectId)).toBe(true)
    })
  })

  describe('cost', () => {
    const counted = new PrismaClient({
      adapter: createPrismaAdapter(),
      log: [{ emit: 'event', level: 'query' }],
    })
    let queries = 0
    counted.$on('query', () => {
      queries += 1
    })
    const queriesFor = async (work: () => Promise<unknown>): Promise<number> => {
      queries = 0
      await work()
      return queries
    }

    const seedSuite = async (tests: number, runs: number, massFailures: number) => {
      const project = await seedProject()
      const ids = await Promise.all(
        Array.from({ length: tests }, (_, index) =>
          project.addTest(`TC-AUTH-${index}`, variant(index % 2 === 0 ? 'ios' : 'android')),
        ),
      )
      for (let run = 0; run < runs; run += 1) {
        await project.addRun(
          ids.map(
            (id, index) => [id, run < massFailures || index === run ? 'fail' : 'pass'] as const,
          ),
        )
      }
      return project.projectId
    }

    afterAll(async () => {
      await counted.$disconnect()
    })

    it('stays the same however many tests, runs and mass failures there are', async () => {
      const small = await seedSuite(6, 2, 1)
      const large = await seedSuite(60, 12, 8)

      const forSmall = await queriesFor(() => getTestCaseMatrix(counted, small))
      const forLarge = await queriesFor(() => getTestCaseMatrix(counted, large))

      expect(forSmall).toBe(4)
      expect(forLarge).toBe(forSmall)
    })

    it('reads no executions for a project with no test cases', async () => {
      const { projectId, addTest, addRun } = await seedProject()
      const test = await addTest('logs in', variant('ios'))
      await addRun([[test, 'pass']])

      expect(await queriesFor(() => getTestCaseMatrix(counted, projectId))).toBe(1)
    })

    it('costs the sidebar one query', async () => {
      const large = await seedSuite(60, 1, 0)

      expect(await queriesFor(() => hasTestCaseComparison(counted, large))).toBe(1)
    })

    it('reaches runs and executions through their indexes, not through all of history', async () => {
      const { projectId, addTest, addRun, addPassingRuns } = await seedProject()
      const tests = await Promise.all(
        ['001', '002', '003', '004', '005', '006'].map((id) =>
          addTest(`TC-AUTH-${id}`, variant('ios')),
        ),
      )
      await addPassingRuns(8000, tests)
      const latest = await addRun(tests.map((test) => [test, 'fail'] as const))
      await prisma.$executeRaw`UPDATE run SET started_at = TIMESTAMP '2027-06-01'
        WHERE id = ${latest}::uuid`
      await prisma.$executeRaw`ANALYZE run`
      await prisma.$executeRaw`ANALYZE test_execution`

      const statements: { query: string; params: string }[] = []
      counted.$on('query', ({ query, params }) => {
        statements.push({ query, params })
      })
      await getTestCaseMatrix(counted, projectId)

      const planOf = async (shape: RegExp): Promise<string> => {
        const statement = statements.find(({ query }) => shape.test(query))
        expect(statement, String(shape)).toBeDefined()
        const params = JSON.parse(statement?.params ?? '[]') as unknown[]
        const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN ${statement?.query ?? ''}`,
          ...params,
        )
        return plan.map((line) => line['QUERY PLAN']).join('\n')
      }

      try {
        expect(await planOf(/FROM run\b/)).toContain('run_project_id_started_at_idx')
        for (const shape of [/count\(DISTINCT test_identity_id\)/, /test_in_run AS/]) {
          const plan = await planOf(shape)
          expect(plan).toContain('test_execution_run_id')
          expect(plan).not.toContain('Seq Scan on test_execution')
          expect(plan).not.toContain('test_execution_project_id_started_at_idx')
          expect(plan).not.toContain('test_execution_test_identity_id_started_at_idx')
        }
      } finally {
        await prisma.project.delete({ where: { id: projectId } })
      }
    })
  })
})
