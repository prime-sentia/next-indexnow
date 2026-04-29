import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/next.ts', 'src/cli.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['next']
});
