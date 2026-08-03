import { PrismaClient } from '@flakemetry/db'
import { applyHistoricalRestitch, planHistoricalRestitch } from '@flakemetry/queries'

export interface RestitchArgs {
  projectId: string
  apply: boolean
  minConfidence?: number
  limit?: number
}

export type RestitchArgsResult = { ok: true; args: RestitchArgs } | { ok: false; reason: string }

const numberFlag = (
  raw: string | undefined,
  name: string,
  check: (value: number) => boolean,
  expected: string,
): { ok: true; value: number | undefined } | { ok: false; reason: string } => {
  if (raw === undefined) return { ok: true, value: undefined }
  const value = Number(raw)
  if (!Number.isFinite(value) || !check(value))
    return { ok: false, reason: `--${name} must be ${expected}, got "${raw}"` }
  return { ok: true, value }
}

export const parseRestitchArgs = (argv: readonly string[]): RestitchArgsResult => {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    if (index < 0) return undefined
    const value = argv[index + 1]
    // A following flag means the value was left off, which must not be read as one.
    return value === undefined || value.startsWith('--') ? undefined : value
  }

  const projectId = flag('project')
  if (!projectId) return { ok: false, reason: '--project <projectId> is required' }

  const minConfidence = numberFlag(
    flag('min-confidence'),
    'min-confidence',
    (value) => value > 0 && value <= 1,
    'a number above 0 and at most 1',
  )
  if (!minConfidence.ok) return minConfidence

  const limit = numberFlag(
    flag('limit'),
    'limit',
    (value) => Number.isInteger(value) && value >= 1,
    'a whole number of at least 1',
  )
  if (!limit.ok) return limit

  return {
    ok: true,
    args: {
      projectId,
      apply: argv.includes('--apply'),
      minConfidence: minConfidence.value,
      limit: limit.value,
    },
  }
}

const USAGE = `usage: restitch --project <projectId> [--apply] [--min-confidence 0.5] [--limit 50]

Re-links test identities that a rename split apart before rename resolution
existed. Without --apply it only prints the plan and changes nothing.
Every applied re-stitch is recorded as an undoable merge.`

export const runRestitch = async (
  prisma: PrismaClient,
  args: RestitchArgs,
  log: (message: string) => void = console.log,
): Promise<number> => {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { id: true, orgId: true, name: true },
  })
  if (!project) {
    log(`project not found: ${args.projectId}`)
    return 1
  }

  const candidates = await planHistoricalRestitch(prisma, project.id, {
    minConfidence: args.minConfidence,
    limit: args.limit,
  })

  log(`${project.name}: ${candidates.length} re-stitch candidate(s)`)
  for (const candidate of candidates) {
    log(
      `  ${candidate.filePath} · ${candidate.suite}: "${candidate.fromTitle}" → "${candidate.toTitle}" (${Math.round(candidate.confidence * 100)}%)`,
    )
  }

  if (!args.apply) {
    log(candidates.length > 0 ? 'dry run — re-run with --apply to re-stitch' : 'nothing to do')
    return 0
  }

  const report = await applyHistoricalRestitch(prisma, project.orgId, project.id, candidates)
  log(`re-stitched ${report.restitched}/${report.planned}`)
  for (const skip of report.skipped) {
    log(`  skipped "${skip.candidate.fromTitle}": ${skip.reason}`)
  }
  return 0
}

export const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseRestitchArgs(argv)
  if (!parsed.ok) {
    console.error(`restitch: ${parsed.reason}\n`)
    console.log(USAGE)
    return 1
  }

  const prisma = new PrismaClient()
  try {
    return await runRestitch(prisma, parsed.args)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1]?.includes('restitch')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
