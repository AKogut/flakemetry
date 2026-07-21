import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@flakemetry/db', '@flakemetry/queries', '@flakemetry/contracts'],
  serverExternalPackages: ['@prisma/client'],
}

export default config
