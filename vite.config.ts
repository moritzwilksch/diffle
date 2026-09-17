import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

const clientRoot = fileURLToPath(new URL('./src/client', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/client', import.meta.url));

export default defineConfig({
  root: clientRoot,
  base: './',
  plugins: [react(), tailwindcss()],
  appType: 'spa',
  // The client ships inside the same package as the server, so the build-time version is the running one.
  define: { __DIFFLE_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: { middlewareMode: true },
});
