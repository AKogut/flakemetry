import type { ReactNode } from 'react'

import { SignOutButton } from '@/components/sign-out-button'
import { requireProjectViewer } from '@/lib/viewer'

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const { project, user, isMember } = await requireProjectViewer(projectId)

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
          {isMember ? <a href="/projects">Projects</a> : null}
          <a href={`/projects/${projectId}/runs`}>Runs</a>
          <a href={`/projects/${projectId}/flaky`}>Flaky board</a>
          <a href={`/projects/${projectId}/suite-health`}>Suite health</a>
          <a href={`/projects/${projectId}/health`}>Test health</a>
          <a href={`/projects/${projectId}/cost`}>Cost</a>
          {isMember ? (
            <>
              <a href={`/projects/${projectId}/settings/policy`}>Policy</a>
              <a href={`/projects/${projectId}/settings/tokens`}>Ingest tokens</a>
              <a href={`/projects/${projectId}/settings/notifications`}>Notifications</a>
              <a href={`/projects/${projectId}/settings/badges`}>Badges</a>
              <a href={`/projects/${projectId}/settings/members`}>Members</a>
              <a href={`/projects/${projectId}/settings/teams`}>Teams</a>
              <a href={`/projects/${projectId}/settings/data`}>Data</a>
              {project.orgRole === 'owner' || project.orgRole === 'admin' ? (
                <a href={`/projects/${projectId}/settings/audit`}>Audit log</a>
              ) : null}
            </>
          ) : null}
        </nav>

        {user ? (
          <div className="user">
            <div>{user.name ?? user.email}</div>
            <SignOutButton />
          </div>
        ) : (
          <div className="user">
            <div className="muted">Public project, read only</div>
            <a href="/sign-in">Sign in</a>
          </div>
        )}
      </aside>

      <main className="main">{children}</main>
    </div>
  )
}
