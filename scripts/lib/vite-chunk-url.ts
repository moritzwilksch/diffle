import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

const QUERY = '?chunk-url';

/**
 * `import url from './x.worker.ts?chunk-url'` is the URL of `x.worker.ts` built as a chunk of the importing
 * build, so a worker shares the page's chunks (every grammar) instead of carrying copies, as a `?worker`
 * bundle does. Outside a build (vitest) it is the source file's URL and the module never runs.
 */
export const chunkUrl = (): Plugin => {
  let build = false;
  return {
    name: 'diffle:chunk-url',
    enforce: 'pre',
    configResolved(config) {
      build = config.command === 'build';
    },
    async resolveId(source, importer) {
      if (!source.endsWith(QUERY)) return null;
      const entry = await this.resolve(source.slice(0, -QUERY.length), importer);
      return entry && `\0${entry.id}${QUERY}`;
    },
    load(id) {
      if (!id.startsWith('\0') || !id.endsWith(QUERY)) return null;
      const file = id.slice(1, -QUERY.length);
      if (!build) return `export default ${JSON.stringify(pathToFileURL(file).href)};`;
      const ref = this.emitFile({ type: 'chunk', id: file, preserveSignature: false });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
};
