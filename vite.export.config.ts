import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// An exported tour's script and styles, which the client inlines into the file it saves: one script,
// one stylesheet with its fonts inlined, and no chunks, so the file asks for nothing. Built after
// the client, into a folder of its own that the client's build would empty.
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./src/client', import.meta.url)),
  plugins: [react(), tailwindcss()],
  publicDir: false,
  resolve: { alias: { '@': srcRoot } },
  // A library build leaves `process.env.NODE_ENV` to its user; this one runs as it is.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('./crates/diffle/client/export', import.meta.url)),
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
