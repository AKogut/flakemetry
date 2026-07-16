import { libraryConfig } from '@flakemetry/tsup-config'
import { defineConfig } from 'tsup'

export default defineConfig({
  ...libraryConfig,
  entry: ['src/index.ts', 'src/cli.ts'],
})
