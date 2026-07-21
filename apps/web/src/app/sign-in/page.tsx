import { redirect } from 'next/navigation'

import { auth, signIn } from '@/lib/auth'

export default async function SignInPage() {
  const session = await auth()
  if (session?.user) redirect('/')

  return (
    <div className="center">
      <div className="card">
        <div className="brand" style={{ marginBottom: '0.5rem' }}>
          flake<span>metry</span>
        </div>
        <p className="page-subtitle">
          Test intelligence for teams that treat tests as telemetry, not reports.
        </p>
        <form
          action={async () => {
            'use server'
            await signIn('github', { redirectTo: '/' })
          }}
        >
          <button className="btn" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
            Continue with GitHub
          </button>
        </form>
      </div>
    </div>
  )
}
