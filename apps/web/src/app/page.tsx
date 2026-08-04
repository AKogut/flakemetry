import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/session'
import { listAccessibleProjects } from '@/lib/tenant'

export default async function HomePage() {
  const user = await requireUser()
  const projects = await listAccessibleProjects(user.id)
  if (projects.length === 0) redirect('/onboarding')
  // With one project the list is a pointless stop; with several it is the only way to
  // reach anything but the first, which used to be unreachable entirely.
  if (projects.length === 1) redirect(`/projects/${projects[0]!.id}/runs`)
  redirect('/projects')
}
