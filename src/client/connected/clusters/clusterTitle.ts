import type { GraphCluster } from '@/shared/protocol.js';
import { isTestPath } from './testPath.js';

/** What a cluster with no shared directory is called when its folder has to stand in for a name. */
export const ROOT_LABEL = '(root)';

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * A cluster's name: the file the most arrow weight points at, tests aside, since that is the file the others
 * exist for. Without one, its smallest source file; with only tests, its folder. The server's order of members
 * and links does not matter, so the name does not flip between refreshes.
 */
export function clusterTitle(c: GraphCluster): string {
  const members = new Set(c.files.filter((f) => !isTestPath(f)));
  const weight = new Map<string, { weight: number; links: number }>();
  for (const l of c.links) {
    if (!members.has(l.to) || !c.files.includes(l.from)) continue;
    const w = weight.get(l.to) ?? { weight: 0, links: 0 };
    weight.set(l.to, { weight: w.weight + l.weight, links: w.links + 1 });
  }
  const [target] = [...weight].sort(([a, x], [b, y]) => y.weight - x.weight || y.links - x.links || byPath(a, b));
  const path = target?.[0] ?? [...members].sort(byPath)[0];
  return path === undefined ? c.label || ROOT_LABEL : basename(path);
}
