import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

// Mirrors `paths` in the tsconfigs: vite's own tsconfig lookup skips files a config excludes.
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': srcRoot } },
  define: { __DIFFLE_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Server tests drive real Git repositories, and each spawn costs far more on the Windows runners.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
