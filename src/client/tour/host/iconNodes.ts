import type { IconNode } from 'lucide-react';

interface IconModule {
  default: unknown;
  __iconData?: { node: IconNode };
}

// Every icon lucide-react ships, in one chunk the live host imports on a tour's first icon: one map
// instead of a chunk per icon keeps the build a few hundred files.
// The folder's index re-exports them all under component names.
const modules = import.meta.glob<IconModule>(
  ['../../../../node_modules/lucide-react/dist/esm/icons/*.mjs', '!**/index.mjs'],
  { eager: true },
);

/** Each icon's drawing by its name on lucide.dev, aliases included. */
export const ICON_NODES: ReadonlyMap<string, IconNode> = (() => {
  // An alias's file holds no drawing; it re-exports its icon's component.
  const byComponent = new Map<unknown, IconNode>();
  for (const m of Object.values(modules)) if (m.__iconData) byComponent.set(m.default, m.__iconData.node);
  const nodes = new Map<string, IconNode>();
  for (const [path, m] of Object.entries(modules)) {
    const node = byComponent.get(m.default);
    if (node) nodes.set(path.slice(path.lastIndexOf('/') + 1, -'.mjs'.length), node);
  }
  return nodes;
})();
