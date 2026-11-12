import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Dependency } from 'rollup-plugin-license';
import { defineConfig } from 'vite';
import type { ExportNotices } from './src/shared/notices.js';
import { gzipAssets, licenses } from './vite.plugins.js';

// An exported tour's script and styles, which the client inlines into the file it saves: one script,
// one stylesheet with its fonts inlined, and no chunks, so the file asks for nothing. Built after
// the client, into a folder of its own that the client's build would empty.
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));
const outDir = fileURLToPath(new URL('./crates/diffle/client/export', import.meta.url));
const fontsNotice = fileURLToPath(new URL('./scripts/licenses-fonts.md', import.meta.url));

/**
 * What the script bundles and the stylesheet embeds, with every licence text an exported file must
 * carry: MIT and ISC want their notice in each copy, Apache-2.0 its licence and NOTICE, the OFL its
 * licence with the fonts. Each text is listed once, under everything it covers.
 */
function notices(dependencies: Dependency[]): string {
  const licences = new Map<string, string[]>();
  const cover = (text: string, name: string) => licences.set(text, [...(licences.get(text) ?? []), name]);
  const bundled: string[] = [];
  for (const d of dependencies) {
    if (!d.licenseText) throw new Error(`${d.name} ships no licence text for an exported tour to carry`);
    const name = `${d.name} ${d.version}`;
    bundled.push(`${name} (${d.license})`);
    cover([d.licenseText, d.noticeText].filter(Boolean).join('\n\n').trim(), name);
  }
  const fonts = fontLicence();
  for (const font of fonts.fonts) {
    bundled.push(`${font} (OFL-1.1)`);
    cover(fonts.text, font);
  }
  const result: ExportNotices = { bundled, licences: [...licences].map(([text, covers]) => ({ covers, text })) };
  return JSON.stringify(result);
}

/**
 * The fonts and their licence as `scripts/licenses-fonts.md` gives them for THIRD_PARTY_NOTICES.md:
 * its `- Name: Copyright …` lines, then the OFL in its fenced block.
 */
function fontLicence(): { fonts: string[]; text: string } {
  const md = readFileSync(fontsNotice, 'utf8');
  const copyrights = [...md.matchAll(/^- ([^:\n]+): (Copyright .+)$/gm)];
  const ofl = /^```\n([^]*?)\n```$/m.exec(md)?.[1];
  if (!copyrights.length || !ofl) throw new Error(`${fontsNotice} lost its copyright lines or its licence block`);
  const text = [...copyrights.map((m) => `${m[1]}: ${m[2]}`), '', ofl].join('\n');
  return { fonts: copyrights.map((m) => m[1]!), text };
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/client', import.meta.url)),
  plugins: [react(), tailwindcss(), licenses(`${outDir}/notices.json`, notices), gzipAssets(outDir)],
  publicDir: false,
  resolve: { alias: { '@': srcRoot } },
  // A library build leaves `process.env.NODE_ENV` to its user; this one runs as it is.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: () => true,
    lib: {
      entry: fileURLToPath(new URL('./src/client/tour/export/main.tsx', import.meta.url)),
      formats: ['iife'],
      name: 'diffleTour',
      fileName: () => 'tour.js',
      cssFileName: 'tour',
    },
  },
});
