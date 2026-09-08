import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/cli/main.ts' },
  outDir: 'dist/server',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
  dts: false,
  // One self-contained file: fast startup, no runtime module resolution.
  deps: { neverBundle: ['vite'], alwaysBundle: (id) => id !== 'vite' },
});
