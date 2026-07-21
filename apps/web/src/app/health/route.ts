export const dynamic = 'force-dynamic'

export const GET = () =>
  Response.json({ status: 'ok', service: 'web' }, { headers: { 'cache-control': 'no-store' } })
