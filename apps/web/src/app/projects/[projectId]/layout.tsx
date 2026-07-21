import type { ReactNode } from 'react'

import { SignOutButton } from '@/components/sign-out-button'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          flake<span>metry</span>
        </div>

        <div>
          <div className="muted" style={{ fontSize: '0.75rem', textTransform: 'uppercase' }}>
            {project.orgName}
          </div>
          <div style={{ fontWeight: 600 }}>{project.name}</div>
        </div>

        <nav className="nav">
          <a href={`/projects/${projectId}/runs`}>Runs</a>
          <a href={`/projects/${projectId}/flaky`}>Flaky board</a>
          <a href={`/projects/${projectId}/settings/tokens`}>Ingest tokens</a>
        </nav>

        <div className="user">
          <div>{user.name ?? user.email}</div>
          <SignOutButton />
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  )
}
