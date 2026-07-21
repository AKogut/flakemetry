import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  transpilePackages: ['@flakemetry/db', '@flakemetry/queries', '@flakemetry/contracts'],
  serverExternalPackages: ['@prisma/client'],
}

export default config
