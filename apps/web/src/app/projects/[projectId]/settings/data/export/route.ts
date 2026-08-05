import { getPrismaClient } from '@flakemetry/db'
import {
  completeRequest,
  exportFilename,
  startExportRecord,
  streamProjectExport,
} from '@flakemetry/queries'
import { projectArtifactPrefix, resolveObjectStore } from '@flakemetry/storage'

import { gzippedExportBody } from '@/lib/export-stream'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> => {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)

  const store = resolveObjectStore(process.env)
  const artifactPrefix = projectArtifactPrefix(project.orgId, project.id)
  const exportedAt = new Date()

  const requestId = await startExportRecord(prisma, {
    orgId: project.orgId,
    projectId: project.id,
    subject: `project "${project.name}" (${project.slug})`,
    actor: user.email ?? user.id,
    actorUserId: user.id,
    artifactPrefix,
  })

  const body = gzippedExportBody(
    streamProjectExport(prisma, {
      projectId: project.id,
      exportedAt,
      artifacts: store ? { prefix: artifactPrefix, store } : null,
      // Swallowed rather than propagated: the archive on the wire is already correct, and
      // failing a download because the bookkeeping did not land would be the audit trail
      // taking the data with it.
      onComplete: (summary) =>
        completeRequest(prisma, requestId, {
          rowCount: summary.rows,
          artifactCount: summary.artifacts,
        }).catch(() => undefined),
    }),
  )

  return new Response(body, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${exportFilename(project.slug, exportedAt)}"`,
      'cache-control': 'no-store',
    },
  })
}
