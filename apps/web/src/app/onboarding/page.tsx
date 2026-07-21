import { createWorkspace } from '@/lib/actions'
import { requireUser } from '@/lib/session'

export default async function OnboardingPage() {
  const user = await requireUser()

  return (
    <div className="center">
      <div className="card">
        <div className="brand" style={{ marginBottom: '0.5rem' }}>
          flake<span>metry</span>
        </div>
        <p className="page-subtitle">
          Welcome{user.name ? `, ${user.name.split(' ')[0]}` : ''}. Create a workspace to start
          collecting test runs.
        </p>

        <form action={createWorkspace}>
          <div className="field">
            <label htmlFor="orgName">Workspace</label>
            <input id="orgName" name="orgName" placeholder="Acme" required />
          </div>
          <div className="field">
            <label htmlFor="projectName">First project</label>
            <input id="projectName" name="projectName" placeholder="Web E2E" required />
          </div>
          <button className="btn" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
            Create workspace
          </button>
        </form>
      </div>
    </div>
  )
}
