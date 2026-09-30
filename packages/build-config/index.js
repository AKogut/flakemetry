const shared = {
  entry: ['src/index.ts'],
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  fixedExtension: false,
}

export const libraryConfig = {
  ...shared,
  format: ['esm', 'cjs'],
  dts: true,
}

export const publishedConfig = {
  ...libraryConfig,
  publint: { level: 'error' },
  attw: { profile: 'strict', level: 'error' },
}

export const serviceConfig = {
  ...shared,
  format: ['esm'],
}
