import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/app.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
})
