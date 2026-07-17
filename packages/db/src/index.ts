import { PrismaClient } from '@prisma/client'

export * from './queue'
export * from './token'
export * from '@prisma/client'

let client: PrismaClient | undefined

export const getPrismaClient = (): PrismaClient => {
  client ??= new PrismaClient()
  return client
}
