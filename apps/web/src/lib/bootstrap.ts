import type { PrismaClient } from '@flakemetry/db'

export const adoptUnclaimedOrgs = async (prisma: PrismaClient, userId: string): Promise<number> => {
  const anyMembership = await prisma.membership.findFirst({ select: { id: true } })
  if (anyMembership) return 0

  const unclaimed = await prisma.org.findMany({
    where: { memberships: { none: {} } },
    select: { id: true },
  })
  if (unclaimed.length === 0) return 0

  await prisma.membership.createMany({
    data: unclaimed.map((org) => ({ userId, orgId: org.id, role: 'owner' as const })),
    skipDuplicates: true,
  })

  return unclaimed.length
}
