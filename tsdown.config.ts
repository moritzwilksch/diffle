import { defineConfig, type UserConfig } from 'tsdown';

const server: UserConfig = {
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
};

export default defineConfig([
  server,
  // A single executable resolves no relative modules, so lazy chunks are inlined.
  { ...server, outDir: 'dist/sea', outputOptions: { codeSplitting: false } },
]);
