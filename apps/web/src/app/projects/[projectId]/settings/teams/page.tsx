import { getPrismaClient } from '@flakemetry/db'
import { canManage, listMembers, listTeams } from '@flakemetry/queries'

import {
  addWorkspaceTeamMember,
  createWorkspaceTeam,
  deleteWorkspaceTeam,
  removeWorkspaceTeamMember,
  updateWorkspaceTeam,
} from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

export default async function TeamsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)

  const [teams, members, grants] = await Promise.all([
    listTeams(prisma, project.orgId),
    listMembers(prisma, project.orgId),
    prisma.projectGrant.findMany({
      where: { orgId: project.orgId, teamId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { teamId: true, role: true, project: { select: { name: true } } },
    }),
  ])

  const manager = canManage(project.orgRole)
  const grantsByTeam = new Map<string, { project: string; role: string }[]>()
  for (const grant of grants) {
    if (!grant.teamId) continue
    const list = grantsByTeam.get(grant.teamId) ?? []
    list.push({ project: grant.project.name, role: grant.role })
    grantsByTeam.set(grant.teamId, list)
  }

  return (
    <>
      <h1 className="page-title">Teams</h1>
      <p className="page-subtitle">
        A team groups people in the <strong>{project.orgName}</strong> workspace. Grant a team
        access to a restricted project on the Members page, and whoever joins the team gets it;
        whoever leaves loses it. A team can carry the CODEOWNERS handle it goes by in the
        repository, such as <span className="mono">@acme/qa</span>, so owners on a test read as
        Flakemetry teams.
      </p>

      {manager ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <form
            action={createWorkspaceTeam}
            style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input name="name" placeholder="Team name" required maxLength={80} />
            <input name="handle" placeholder="@org/team (optional)" className="mono" />
            <button className="btn" type="submit" style={{ whiteSpace: 'nowrap' }}>
              Create team
            </button>
          </form>
        </div>
      ) : null}

      {teams.length === 0 ? (
        <div className="card">
          <div className="empty">
            {manager
              ? 'No teams yet. Create one above, then add people to it.'
              : 'No teams yet. Owners and admins create them.'}
          </div>
        </div>
      ) : null}

      {teams.map((team) => {
        const inTeam = new Set(team.members.map((member) => member.userId))
        const addable = members.filter((member) => !inTeam.has(member.userId))
        const access = grantsByTeam.get(team.id) ?? []

        return (
          <div key={team.id} className="card" style={{ marginBottom: '1.25rem' }}>
            {manager ? (
              <form
                action={updateWorkspaceTeam}
                style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="teamId" value={team.id} />
                <input
                  name="name"
                  defaultValue={team.name}
                  required
                  maxLength={80}
                  aria-label="Team name"
                  style={{ fontWeight: 600 }}
                />
                <input
                  name="handle"
                  defaultValue={team.handle ?? ''}
                  placeholder="@org/team"
                  className="mono"
                  aria-label="CODEOWNERS handle"
                />
                <button className="btn" type="submit">
                  Save
                </button>
              </form>
            ) : (
              <h2 style={{ marginTop: 0 }}>
                {team.name}
                {team.handle ? <span className="muted mono"> {team.handle}</span> : null}
              </h2>
            )}

            <div className="muted" style={{ fontSize: '0.85rem', margin: '0.75rem 0' }}>
              {access.length === 0
                ? 'No project grants.'
                : `Access: ${access.map((grant) => `${grant.project} (${grant.role})`).join(', ')}`}
            </div>

            {team.members.length === 0 ? (
              <div className="empty">Nobody in this team yet.</div>
            ) : (
              <table>
                <tbody>
                  {team.members.map((member) => (
                    <tr key={member.userId}>
                      <td>
                        {member.name ?? member.email ?? 'unknown'}
                        {member.userId === user.id ? <span className="muted"> (you)</span> : null}
                      </td>
                      {manager ? (
                        <td style={{ textAlign: 'right' }}>
                          <form action={removeWorkspaceTeamMember}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="teamId" value={team.id} />
                            <input type="hidden" name="userId" value={member.userId} />
                            <button className="btn btn-danger" type="submit">
                              Remove
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {manager ? (
              <div className="row-between" style={{ marginTop: '0.75rem', gap: '0.75rem' }}>
                {addable.length > 0 ? (
                  <form action={addWorkspaceTeamMember} style={{ display: 'flex', gap: '0.5rem' }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="teamId" value={team.id} />
                    <select name="userId" aria-label="Person to add">
                      {addable.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name ?? member.email ?? 'unknown'}
                        </option>
                      ))}
                    </select>
                    <button className="btn" type="submit">
                      Add
                    </button>
                  </form>
                ) : (
                  <span className="muted">Everyone in the workspace is in this team.</span>
                )}
                <form action={deleteWorkspaceTeam}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="teamId" value={team.id} />
                  <button className="btn btn-danger" type="submit">
                    Delete team
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
