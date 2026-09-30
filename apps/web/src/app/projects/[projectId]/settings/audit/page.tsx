import { getPrismaClient } from '@flakemetry/db'
import { canManage, listAuditEvents } from '@flakemetry/queries'
import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const formatWhen = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)

const describeDetails = (details: unknown): string => {
  if (!details || typeof details !== 'object') return ''
  return Object.entries(details as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join(' · ')
}

export default async function AuditPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.orgRole)) redirect(`/projects/${projectId}/runs`)

  const [events, projects] = await Promise.all([
    listAuditEvents(prisma, project.orgId, { limit: 200 }),
    prisma.project.findMany({ where: { orgId: project.orgId }, select: { id: true, name: true } }),
  ])
  const projectNames = new Map(projects.map((entry) => [entry.id, entry.name]))

  return (
    <>
      <h1 className="page-title">Audit log</h1>
      <p className="page-subtitle">
        Every change to access, tokens, policy, notifications, quarantine and data in the{' '}
        <strong>{project.orgName}</strong> workspace, newest first. Only owners and admins can read
        it, and entries outlive the projects and people they mention.
      </p>

      <div className="card">
        {events.length === 0 ? (
          <div className="empty">Nothing recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Project</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="muted">{formatWhen(event.createdAt)}</td>
                  <td>{event.actorName ?? (event.actorId ? 'former member' : 'system')}</td>
                  <td className="mono">
                    {event.action}
                    {event.target ? <span className="muted"> {event.target}</span> : null}
                  </td>
                  <td className="muted">
                    {event.projectId
                      ? (projectNames.get(event.projectId) ?? 'deleted project')
                      : '—'}
                  </td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>
                    {describeDetails(event.details)}
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
