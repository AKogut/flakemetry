import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

export * from './queue'
export * from './token'
export * from '@prisma/client'

export interface PostgresConnection {
  connectionString: string
  schema: string
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const parseDatabaseUrl = (databaseUrl: string | undefined): PostgresConnection => {
  if (!databaseUrl) return { connectionString: '', schema: 'public' }
  const url = new URL(databaseUrl)
  const schema = url.searchParams.get('schema') || 'public'
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(`DATABASE_URL names schema "${schema}", which is not a plain identifier`)
  }
  url.searchParams.delete('schema')
  return { connectionString: url.toString(), schema }
}

export const createPrismaAdapter = (databaseUrl = process.env.DATABASE_URL): PrismaPg => {
  const { connectionString, schema } = parseDatabaseUrl(databaseUrl)
  return new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema })
}

export const createPrismaClient = (databaseUrl = process.env.DATABASE_URL): PrismaClient =>
  new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) })

let client: PrismaClient | undefined

export const getPrismaClient = (): PrismaClient => {
  client ??= createPrismaClient()
  return client
}
