import { getPrismaClient } from '@flakemetry/db'
import { effectiveProjectRole } from '@flakemetry/queries'
import { redirect } from 'next/navigation'

const prisma = getPrismaClient()

const grantsReaching = (userId: string) => ({
  where: { OR: [{ userId }, { team: { members: { some: { userId } } } }] },
  select: { role: true },
})

export interface AccessibleProject {
  id: string
  name: string
  slug: string
  orgId: string
  orgName: string
  orgSlug: string
  role: string
  orgRole: string
  restricted: boolean
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
            select: {
              id: true,
              name: true,
              slug: true,
              restricted: true,
              grants: grantsReaching(userId),
            },
          },
        },
      },
    },
  })

  return memberships.flatMap((membership) =>
    membership.org.projects.flatMap((project) => {
      const role = effectiveProjectRole({
        orgRole: membership.role,
        restricted: project.restricted,
        grantRoles: project.grants.map((grant) => grant.role),
      })
      if (!role) return []
      return [
        {
          id: project.id,
          name: project.name,
          slug: project.slug,
          orgId: membership.org.id,
          orgName: membership.org.name,
          orgSlug: membership.org.slug,
          role,
          orgRole: membership.role,
          restricted: project.restricted,
        },
      ]
    }),
  )
}

export const findProjectAccess = async (
  userId: string,
  projectId: string,
): Promise<AccessibleProject | null> => {
  const project = await prisma.project.findFirst({
    where: { id: projectId, org: { memberships: { some: { userId } } } },
    select: {
      id: true,
      name: true,
      slug: true,
      restricted: true,
      grants: grantsReaching(userId),
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
  if (!project) return null

  const orgRole = project.org.memberships[0]?.role
  if (!orgRole) return null
  const role = effectiveProjectRole({
    orgRole,
    restricted: project.restricted,
    grantRoles: project.grants.map((grant) => grant.role),
  })
  if (!role) return null

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    orgId: project.org.id,
    orgName: project.org.name,
    orgSlug: project.org.slug,
    role,
    orgRole,
    restricted: project.restricted,
  }
}

export const requireProjectAccess = async (
  userId: string,
  projectId: string,
): Promise<AccessibleProject> => {
  const project = await findProjectAccess(userId, projectId)
  if (!project) redirect('/')
  return project
}

export const resolveActiveProject = async (
  userId: string,
  requestedProjectId?: string,
): Promise<AccessibleProject | null> => {
  if (requestedProjectId) return requireProjectAccess(userId, requestedProjectId)
  const projects = await listAccessibleProjects(userId)
  return projects[0] ?? null
}
