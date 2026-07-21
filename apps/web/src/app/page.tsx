import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/session'
import { listAccessibleProjects } from '@/lib/tenant'

export default async function HomePage() {
  const user = await requireUser()
  const projects = await listAccessibleProjects(user.id)
  if (projects.length === 0) redirect('/onboarding')
  redirect(`/projects/${projects[0]!.id}/runs`)
}
