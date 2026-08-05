import { getPrismaClient, hashToken } from '@flakemetry/db'
import { findInvitationByHash, type InvitationState } from '@flakemetry/queries'
import { redirect } from 'next/navigation'

import { acceptInvite } from '@/lib/actions'
import { auth } from '@/lib/auth'

const prisma = getPrismaClient()

const REFUSED: Record<Exclude<InvitationState, 'pending'> | 'unknown', string> = {
  accepted: 'This invitation has already been used.',
  revoked: 'This invitation was cancelled.',
  expired: 'This invitation has expired. Ask for a new one.',
  unknown: 'This invitation link is not valid.',
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { token } = await params
  const { error } = await searchParams

  // Not `requireUser`: that would send them to sign in and then drop them on the dashboard,
  // losing the invitation they came here to accept.
  const session = await auth()
  if (!session?.user?.id) {
    redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`)
  }

  const invitation = await findInvitationByHash(prisma, hashToken(token))
  const refusal =
    error && error in REFUSED
      ? REFUSED[error as keyof typeof REFUSED]
      : !invitation
        ? REFUSED.unknown
        : invitation.state !== 'pending'
          ? REFUSED[invitation.state]
          : null

  return (
    <div className="center">
      <div className="card">
        <div className="brand" style={{ marginBottom: '0.5rem' }}>
          flake<span>metry</span>
        </div>

        {refusal ? (
          <>
            <p className="page-subtitle">{refusal}</p>
            <a className="btn" href="/">
              Go to your projects
            </a>
          </>
        ) : (
          <>
            <p className="page-subtitle">
              You have been invited to <strong>{invitation?.orgName}</strong> as{' '}
              <strong>{invitation?.role}</strong>.
            </p>
            <form action={acceptInvite}>
              <input type="hidden" name="token" value={token} />
              <button
                className="btn"
                type="submit"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                Join the workspace
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
