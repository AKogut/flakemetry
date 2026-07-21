import { getPrismaClient } from '@flakemetry/db'
import { redirect } from 'next/navigation'

const prisma = getPrismaClient()

export interface AccessibleProject {
  id: string
  name: string
  slug: string
  orgId: string
  orgName: string
  orgSlug: string
  role: string
}

export const listAccessibleProjects = async (userId: string): Promise<AccessibleProject[]> => {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: {
      role: true,
      org: {
        select: {
          id: true,
          name: true,
          slug: true,
          projects: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, name: true, slug: true },
          },
        },
      },
    },
  })

  return memberships.flatMap((membership) =>
    membership.org.projects.map((project) => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
      orgId: membership.org.id,
      orgName: membership.org.name,
      orgSlug: membership.org.slug,
      role: membership.role,
    })),
  )
}

export const requireProjectAccess = async (
  userId: string,
  projectId: string,
): Promise<AccessibleProject> => {
  const project = await prisma.project.findFirst({
    where: { id: projectId, org: { memberships: { some: { userId } } } },
    select: {
      id: true,
      name: true,
      slug: true,
      org: {
        select: {
          id: true,
          name: true,
          slug: true,
          memberships: { where: { userId }, select: { role: true }, take: 1 },
        },
      },
    },
  })
  if (!project) redirect('/')

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    orgId: project.org.id,
    orgName: project.org.name,
    orgSlug: project.org.slug,
    role: project.org.memberships[0]?.role ?? 'member',
  }
}

export const resolveActiveProject = async (
  userId: string,
  requestedProjectId?: string,
): Promise<AccessibleProject | null> => {
  if (requestedProjectId) return requireProjectAccess(userId, requestedProjectId)
  const projects = await listAccessibleProjects(userId)
  return projects[0] ?? null
}
