import { PrismaAdapter } from '@auth/prisma-adapter'
import { getPrismaClient } from '@flakemetry/db'
import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'

import { adoptUnclaimedOrgs } from './bootstrap'
import { resolveSsoProvider } from './sso'

const prisma = getPrismaClient()
const sso = resolveSsoProvider(process.env)

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: sso ? [GitHub, sso] : [GitHub],
  session: { strategy: 'database' },
  pages: { signIn: '/sign-in' },
  events: {
    async signIn({ user }) {
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
