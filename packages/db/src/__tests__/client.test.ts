import { afterAll, describe, expect, it } from 'vitest'

import { createPrismaClient, parseDatabaseUrl } from '../index'

describe('parseDatabaseUrl', () => {
  it('moves the schema out of the connection string, where the pg driver would drop it', () => {
    expect(
      parseDatabaseUrl('postgresql://u:p@db:5432/flakemetry?schema=tenant_a&sslmode=require'),
    ).toEqual({
      connectionString: 'postgresql://u:p@db:5432/flakemetry?sslmode=require',
      schema: 'tenant_a',
    })
  })

  it('defaults to public', () => {
    expect(parseDatabaseUrl('postgresql://u:p@db:5432/flakemetry').schema).toBe('public')
  })

  it('tolerates a missing url, so a build without a database can still import the client', () => {
    expect(parseDatabaseUrl(undefined)).toEqual({ connectionString: '', schema: 'public' })
  })

  it('refuses a schema that is not a plain identifier', () => {
    expect(() => parseDatabaseUrl('postgresql://u:p@db/x?schema=a;drop')).toThrow(/identifier/)
  })
})

const url = process.env.DATABASE_URL
const hasDb = Boolean(url)

describe.skipIf(!hasDb)('a client built from DATABASE_URL', () => {
  const schema = hasDb ? parseDatabaseUrl(url).schema : 'public'
  const prisma = createPrismaClient(url)

  afterAll(async () => {
    await prisma.org.deleteMany({ where: { slug: { startsWith: 'schema-probe-' } } })
    await prisma.$disconnect()
  })

  it('works in the schema the url names, not in public', async () => {
    expect(schema).not.toBe('public')

    const [session] = await prisma.$queryRaw<
      { schema: string }[]
    >`select current_schema() as schema`
    expect(session?.schema).toBe(schema)

    const slug = `schema-probe-${Date.now()}`
    await prisma.org.create({ data: { name: 'probe', slug } })
    const [found] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `select count(*)::int as n from "${schema}".org where slug = $1`,
      slug,
    )
    const [publicOrg] = await prisma.$queryRaw<{ exists: boolean }[]>`
      select to_regclass('public.org') is not null as exists`
    const leaked = publicOrg?.exists
      ? await prisma.$queryRawUnsafe<{ n: number }[]>(
          `select count(*)::int as n from public.org where slug = $1`,
          slug,
        )
      : [{ n: 0 }]
    expect(found?.n).toBe(1)
    expect(leaked[0]?.n).toBe(0)
  })
})
