import { redirect } from 'next/navigation'

import { auth } from './auth'

export interface SessionUser {
  id: string
  name: string | null
  email: string | null
  image: string | null
}

export const requireUser = async (): Promise<SessionUser> => {
  const session = await auth()
  if (!session?.user?.id) redirect('/sign-in')
  return {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  }
}
