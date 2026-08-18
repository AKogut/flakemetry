import { createRequire } from 'node:module'

import { libraryConfig } from '@flakemetry/tsup-config'
import { defineConfig } from 'tsup'

const { version } = createRequire(import.meta.url)('./package.json') as { version: string }

export default defineConfig({
  ...libraryConfig,
  entry: ['src/index.ts', 'src/cli.ts'],
  // Baked in at build time rather than read at runtime: the published package has no
  // package.json beside the bundle to resolve, and `--version` is the first thing anyone
  // is asked for in a bug report.
  define: { __CLI_VERSION__: JSON.stringify(version) },
})
