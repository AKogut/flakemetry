import { redirect } from 'next/navigation'

import { auth } from './auth'
import type { SessionUser } from './session'
import { type ProjectViewer, resolveProjectViewer } from './tenant'

export interface ProjectVisitor extends ProjectViewer {
  user: SessionUser | null
}

export const requireProjectViewer = async (projectId: string): Promise<ProjectVisitor> => {
  const session = await auth()
  const sessionUser = session?.user
  const user: SessionUser | null = sessionUser?.id
    ? {
        id: sessionUser.id,
        name: sessionUser.name ?? null,
        email: sessionUser.email ?? null,
        image: sessionUser.image ?? null,
      }
    : null

  const viewer = await resolveProjectViewer(user?.id ?? null, projectId)
  if (!viewer) redirect(user ? '/' : '/sign-in')
  return { ...viewer, user }
}
