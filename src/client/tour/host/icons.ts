import { icons, type LucideIcon } from 'lucide-react';

// Every icon lucide-react ships, by component name, in the one chunk the live host imports on a
// tour's first icon. Names lucide keeps only as aliases of a renamed icon are not among them.
const byComponent: Readonly<Record<string, LucideIcon>> = icons;

/** The icon named `name` on lucide.dev (`arrow-down-0-1` is `ArrowDown01`), or null when there is none. */
export function iconNamed(name: string): LucideIcon | null {
  const component = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return Object.hasOwn(byComponent, component) ? byComponent[component]! : null;
}
