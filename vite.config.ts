import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { chunkUrl } from './scripts/lib/vite-chunk-url.js';
import pkg from './package.json' with { type: 'json' };
import { gzipAssets, licenses } from './vite.plugins.js';

const clientRoot = fileURLToPath(new URL('./src/client', import.meta.url));
// Mirrors `paths` in the tsconfigs: vite's own tsconfig lookup skips files a config excludes.
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));
const outDir = fileURLToPath(new URL('./crates/diffle/client', import.meta.url));

// Lists every package the build pulled in, workers included, for scripts/licenses.ts.
const licensesJson = () =>
  licenses(fileURLToPath(new URL('./dist/client-licenses.json', import.meta.url)), (dependencies) =>
    JSON.stringify(
      dependencies.map((d) => ({
        name: d.name,
        version: d.version,
        license: d.license,
        licenseText: d.licenseText,
        noticeText: d.noticeText,
        repository: typeof d.repository === 'string' ? d.repository : (d.repository?.url ?? null),
      })),
      null,
      2,
    ),
  );

export default defineConfig({
  root: clientRoot,
  base: './',
  plugins: [react(), tailwindcss(), chunkUrl(), licensesJson(), gzipAssets(outDir)],
  resolve: { alias: { '@': srcRoot } },
  appType: 'spa',
  // The binary embeds the client it was built with, so the build-time version is the running one.
  define: { __DIFFLE_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Vite's preload helper reaches for `document`, which a worker chunk sharing it lacks. Off localhost-only
    // serving, the round trip a preload saves is negligible; the one stylesheet loads from index.html.
    modulePreload: false,
  },
});
