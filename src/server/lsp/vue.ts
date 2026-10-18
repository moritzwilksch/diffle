import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { realExecutable } from './which.js';

/** The tsserver plugin that turns .vue files into TypeScript documents. */
export const VUE_PLUGIN = '@vue/typescript-plugin';

/**
 * Where tsserver loads the Vue plugin from, given the `vue-language-server` executable,
 * or null when no package holding the plugin is found beside it. Vue language tools 3
 * serve .vue files through this plugin inside tsserver; the standalone server only
 * relays to a tsserver the editor must bridge, so diffle never runs it. The package is
 * reached through the layouts of npm (a symlink into the package, or a `.cmd` shim
 * beside `node_modules` on Windows), conda and pixi (a launcher in `bin` beside
 * `lib/node_modules`, behind a pixi global trampoline), and nixpkgs (a wrapper beside
 * `lib/language-tools`).
 */
export function vuePluginLocation(executable: string): string | null {
  const real = realExecutable(executable);
  const candidates = [
    resolve(dirname(real), '..'),
    join(dirname(executable), 'node_modules', '@vue', 'language-server'),
    resolve(dirname(real), '..', 'lib', 'node_modules', '@vue', 'language-server'),
    resolve(dirname(real), '..', 'lib', 'language-tools', 'packages', 'language-server'),
  ];
  for (const dir of candidates) {
    try {
      // The same walk up `node_modules` tsserver makes from the location it is given.
      createRequire(join(dir, 'package.json')).resolve(VUE_PLUGIN);
      return dir;
    } catch {
      /* Not this layout. */
    }
  }
  return null;
}

/** A tsserver plugin entry (`initializationOptions.plugins` / `globalPlugins`) for .vue files. */
export interface TsserverPlugin {
  name: string;
  location: string;
  languages: string[];
}

/**
 * The tsserver plugin entry for .vue files when `vue-language-server` is on PATH, else
 * null. Loaded whenever a TypeScript server starts, not only when the diff holds a .vue
 * file: a process serving .ts files first and .vue files after a refresh cannot load it
 * later, and .ts files importing components resolve them. `lookup` is the PATH probe.
 */
export function vuePlugin(lookup: (command: string) => string | null): TsserverPlugin | null {
  const executable = lookup('vue-language-server');
  const location = executable == null ? null : vuePluginLocation(executable);
  return location == null ? null : { name: VUE_PLUGIN, location, languages: ['vue'] };
}
