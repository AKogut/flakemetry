import { PrismaClient } from '@flakemetry/db'
import { applyHistoricalRestitch, planHistoricalRestitch } from '@flakemetry/queries'

export interface RestitchArgs {
  projectId: string
  apply: boolean
  minConfidence?: number
  limit?: number
}

export const parseRestitchArgs = (argv: readonly string[]): RestitchArgs | null => {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }

  const projectId = flag('project')
  if (!projectId) return null

  const minConfidence = flag('min-confidence')
  const limit = flag('limit')

  return {
    projectId,
    apply: argv.includes('--apply'),
    minConfidence: minConfidence ? Number(minConfidence) : undefined,
    limit: limit ? Number.parseInt(limit, 10) : undefined,
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
  const args = parseRestitchArgs(argv)
  if (!args) {
    console.log(USAGE)
    return 1
  }

  const prisma = new PrismaClient()
  try {
    return await runRestitch(prisma, args)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1]?.includes('restitch')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
