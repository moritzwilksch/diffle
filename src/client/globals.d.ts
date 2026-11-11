/** Package version substituted by Vite (`define` in vite.config.ts and vitest.config.ts). */
declare const __DIFFLE_VERSION__: string;

/** A worker built as a chunk of the page's build (`workerChunks` in vite.config.ts): its URL, for a module worker. */
declare module '*?chunk-url' {
  const url: string;
  export default url;
}
