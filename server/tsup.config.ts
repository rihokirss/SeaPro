import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // @seapro/shared on ainult TS-lähtekood ilma build-sammuta — bundeldame sisse.
  noExternal: ['@seapro/shared'],
});
