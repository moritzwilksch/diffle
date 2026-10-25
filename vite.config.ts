import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import license from 'rollup-plugin-license';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

const clientRoot = fileURLToPath(new URL('./src/client', import.meta.url));
// Mirrors `paths` in the tsconfigs: vite's own tsconfig lookup skips files a config excludes.
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));
const outDir = fileURLToPath(new URL('./crates/diffle/client', import.meta.url));

// Lists every package a bundle pulled in, for scripts/licenses.ts; the worker is its own bundle
// with its own plugins, so each writes its own list. A package under another licence fails the
// build: accept it here on purpose, or drop the package. Compared ignoring case, since
// package.json files spell the SPDX ids freely.
const ACCEPTED_LICENSES = ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD'];
const licenses = (bundle: string) =>
  license({
    thirdParty: {
      multipleVersions: true,
      allow: {
        test: (d) => ACCEPTED_LICENSES.some((id) => id.toLowerCase() === d.license?.toLowerCase()),
        failOnUnlicensed: true,
        failOnViolation: true,
      },
      output: {
        file: fileURLToPath(new URL(`./dist/${bundle}-licenses.json`, import.meta.url)),
        template: (dependencies) =>
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
      },
    },
  });

export default defineConfig({
  root: clientRoot,
  base: './',
  plugins: [react(), tailwindcss(), licenses('client')],
  resolve: { alias: { '@': srcRoot } },
  appType: 'spa',
  // The binary embeds the client it was built with, so the build-time version is the running one.
  define: { __DIFFLE_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  worker: { format: 'es', plugins: () => [licenses('worker')] },
});
