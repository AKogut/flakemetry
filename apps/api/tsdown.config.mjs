import { serviceConfig } from '@flakemetry/build-config'
import { defineConfig } from 'tsdown'

export default defineConfig({
  ...serviceConfig,
  entry: ['src/index.ts', 'src/app.ts'],
  dts: true,
})
