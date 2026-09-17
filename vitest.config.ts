import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: { __DIFFLE_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
