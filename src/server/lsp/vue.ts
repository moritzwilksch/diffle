import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/** The tsserver plugin that turns .vue files into TypeScript documents. */
export const VUE_PLUGIN = '@vue/typescript-plugin';

/**
 * Where tsserver loads the Vue plugin from, given the `vue-language-server` executable,
 * or null when no package holding the plugin is found beside it. Vue language tools 3
 * serve .vue files through this plugin inside tsserver; the standalone server only
 * relays to a tsserver the editor must bridge, so diffle never runs it. The package is
 * reached through the layouts of npm (a symlink into the package, or a `.cmd` shim
 * beside `node_modules` on Windows) and nixpkgs (a wrapper beside `lib/language-tools`).
 */
export function vuePluginLocation(executable: string): string | null {
  const bin = dirname(executable);
  const candidates = [
    join(bin, 'node_modules', '@vue', 'language-server'),
    resolve(bin, '..', 'lib', 'language-tools', 'packages', 'language-server'),
  ];
  try {
    candidates.unshift(resolve(dirname(realpathSync(executable)), '..'));
  } catch {
    /* A dangling link leads nowhere. */
  }
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
