import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { chunkUrl } from './scripts/lib/vite-chunk-url.js';
import pkg from './package.json' with { type: 'json' };
import { licenses } from './vite.licenses.js';

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

// The binary embeds the client as gzip, which every browser accepts over plain HTTP (brotli only over
// HTTPS): `x.js` becomes `x.js.gz` and the server sends it encoded. Fonts are compressed already.
const COMPRESSIBLE = /\.(?:html|js|css|svg|json|wasm|txt)$/;
const gzipAssets = (): Plugin => ({
  name: 'diffle:gzip-assets',
  apply: 'build',
  closeBundle() {
    for (const name of readdirSync(outDir, { recursive: true, encoding: 'utf8' })) {
      if (!COMPRESSIBLE.test(name)) continue;
      const path = join(outDir, name);
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path), { level: constants.Z_BEST_COMPRESSION }));
      unlinkSync(path);
    }
  },
});

export default defineConfig({
  root: clientRoot,
  base: './',
  plugins: [react(), tailwindcss(), chunkUrl(), licensesJson(), gzipAssets()],
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
