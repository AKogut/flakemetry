import { createProject } from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { listAccessibleProjects } from '@/lib/tenant'

const canManage = (role: string): boolean => role === 'owner' || role === 'admin'

export default async function ProjectsPage() {
  const user = await requireUser()
  const projects = await listAccessibleProjects(user.id)

  const workspaces = new Map<string, { name: string; role: string; projects: typeof projects }>()
  for (const project of projects) {
    const existing = workspaces.get(project.orgId)
    if (existing) existing.projects.push(project)
    else
      workspaces.set(project.orgId, {
        name: project.orgName,
        role: project.role,
        projects: [project],
      })
  }

  return (
    <div className="container">
      <h1 className="page-title">Projects</h1>
      <p className="page-subtitle">
        Each project keeps its own history, policy and ingest tokens. Add one per repository or
        suite you want tracked separately.
      </p>

      {[...workspaces.entries()].map(([orgId, workspace]) => (
        <div className="card" key={orgId} style={{ marginBottom: '1.25rem' }}>
          <div className="row-between" style={{ marginBottom: '0.6rem' }}>
            <strong>{workspace.name}</strong>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {workspace.projects.length} project{workspace.projects.length === 1 ? '' : 's'}
            </span>
          </div>

          <ul className="reasons">
            {workspace.projects.map((project) => (
              <li key={project.id}>
                <a href={`/projects/${project.id}/runs`}>{project.name}</a>
                <span className="mono muted" style={{ fontSize: '0.8rem' }}>
                  {' '}
                  · {project.slug}
                </span>
                <span style={{ float: 'right' }}>
                  <a
                    className="mono muted"
                    style={{ fontSize: '0.8rem' }}
                    href={`/projects/${project.id}/settings/tokens`}
                  >
                    tokens
                  </a>
                </span>
              </li>
            ))}
          </ul>

          {canManage(workspace.role) ? (
            <form
              action={createProject}
              className="row-between"
              style={{ gap: '0.5rem', marginTop: '0.8rem' }}
            >
              <input type="hidden" name="orgId" value={orgId} />
              <input
                className="input"
                name="projectName"
                placeholder="New project name"
                required
                style={{ flex: 1 }}
              />
              <button className="btn" type="submit">
                Add project
              </button>
            </form>
          ) : null}
        </div>
      ))}
    </div>
  )
}
