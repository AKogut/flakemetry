import { createRequire } from 'node:module'

import { publishedConfig } from '@flakemetry/build-config'
import { defineConfig } from 'tsdown'

const { version } = createRequire(import.meta.url)('./package.json') as { version: string }

export default defineConfig({
  ...publishedConfig,
  entry: ['src/index.ts', 'src/cli.ts'],
  define: { __CLI_VERSION__: JSON.stringify(version) },
})
