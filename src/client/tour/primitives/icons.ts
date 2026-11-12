import * as lucide from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Every icon lucide-react exports, in the one chunk a tour imports on its first icon.
// The namespace holds the aliases of renamed icons too (`Home` is `House`), which `icons` lacks.
const exported: Readonly<Record<string, unknown>> = lucide;
// Only real icons draw: the namespace also exports `Icon`, `createLucideIcon` and the like.
const drawable: ReadonlySet<unknown> = new Set(Object.values(lucide.icons));

/** The icon named `name` on lucide.dev (`arrow-down-0-1` is `ArrowDown01`), or null when there is none. */
export function iconNamed(name: string): LucideIcon | null {
  const component = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const found = Object.hasOwn(exported, component) ? exported[component] : undefined;
  return drawable.has(found) ? (found as LucideIcon) : null;
}
