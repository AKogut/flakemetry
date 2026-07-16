import { PrismaClient } from '@prisma/client'

export * from '@prisma/client'

let client: PrismaClient | undefined

export const getPrismaClient = (): PrismaClient => {
  client ??= new PrismaClient()
  return client
}
