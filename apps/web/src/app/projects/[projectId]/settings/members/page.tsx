import { getPrismaClient } from '@flakemetry/db'
import { listInvitations, listMembers, MEMBER_ROLES } from '@flakemetry/queries'
import { cookies, headers } from 'next/headers'

import {
  cancelInvitation,
  inviteMember,
  removeMemberFromWorkspace,
  updateMemberRole,
} from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'
import { NEW_INVITE_COOKIE } from '@/lib/token-cookie'

const prisma = getPrismaClient()

const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)

const inviteUrl = async (token: string): Promise<string> => {
  const host = (await headers()).get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  return `${protocol}://${host}/invite/${token}`
}

export default async function MembersPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)

  const [members, invitations] = await Promise.all([
    listMembers(prisma, project.orgId),
    listInvitations(prisma, project.orgId),
  ])

  const created = (await cookies()).get(NEW_INVITE_COOKIE)?.value ?? null
  const canManage = project.role === 'owner' || project.role === 'admin'
  const isOwner = project.role === 'owner'
  const pending = invitations.filter((invitation) => invitation.state === 'pending')

  return (
    <>
      <h1 className="page-title">Members</h1>
      <p className="page-subtitle">
        Everyone in the <strong>{project.orgName}</strong> workspace can see every project in it.
      </p>

      {created ? (
        <div className="card" style={{ marginBottom: '1.25rem', borderColor: 'var(--accent)' }}>
          <strong>Send this link — it is shown only once.</strong>
          <div className="token-value mono">{await inviteUrl(created)}</div>
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            Whoever opens it joins the workspace, so treat it like a password. It expires in seven
            days and can be cancelled below.
          </div>
        </div>
      ) : null}

      {canManage ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <form action={inviteMember} style={{ display: 'flex', gap: '0.75rem' }}>
            <input type="hidden" name="projectId" value={projectId} />
            <input name="email" type="email" placeholder="teammate@acme.com" required />
            <select name="role" defaultValue="member">
              {MEMBER_ROLES.filter((role) => isOwner || role === 'member').map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button className="btn" type="submit" style={{ whiteSpace: 'nowrap' }}>
              Invite
            </button>
          </form>
          {isOwner ? null : (
            <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
              Only the owner can invite another admin or owner.
            </p>
          )}
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Joined</th>
              {canManage ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.name ?? member.email ?? 'unknown'}
                  {member.userId === user.id ? <span className="muted"> (you)</span> : null}
                </td>
                <td>
                  {isOwner ? (
                    <form action={updateMemberRole} style={{ display: 'flex', gap: '0.4rem' }}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="userId" value={member.userId} />
                      <select name="role" defaultValue={member.role}>
                        {MEMBER_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                      <button className="btn" type="submit">
                        Save
                      </button>
                    </form>
                  ) : (
                    member.role
                  )}
                </td>
                <td className="muted">{formatDate(member.joinedAt)}</td>
                {canManage ? (
                  <td style={{ textAlign: 'right' }}>
                    <form action={removeMemberFromWorkspace}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="userId" value={member.userId} />
                      <button className="btn btn-danger" type="submit">
                        {member.userId === user.id ? 'Leave' : 'Remove'}
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Pending invitations</h2>
          {pending.length === 0 ? (
            <div className="empty">None outstanding.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{invitation.role}</td>
                    <td className="muted">{formatDate(invitation.expiresAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <form action={cancelInvitation}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="invitationId" value={invitation.id} />
                        <button className="btn btn-danger" type="submit">
                          Cancel
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  )
}
