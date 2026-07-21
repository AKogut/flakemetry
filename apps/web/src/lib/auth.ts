import { PrismaAdapter } from '@auth/prisma-adapter'
import { getPrismaClient } from '@flakemetry/db'
import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'

import { adoptUnclaimedOrgs } from './bootstrap'

const prisma = getPrismaClient()

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [GitHub],
  session: { strategy: 'database' },
  pages: { signIn: '/sign-in' },
  events: {
    async createUser({ user }) {
      if (user.id) await adoptUnclaimedOrgs(prisma, user.id)
    },
  },
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id
      return session
    },
  },
})
