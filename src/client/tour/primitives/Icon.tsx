import { Icon, type IconNode } from 'lucide-react';
import type dynamicIconImports from 'lucide-react/dynamicIconImports';
import { type ComponentProps, useEffect, useState } from 'react';

type IconName = keyof typeof dynamicIconImports;
/** Each icon drawn so far, so a later mount draws it at once. */
const loaded = new Map<string, IconNode>();

/** An icon's drawing, from its chunk; the map of every icon's chunk is a chunk of its own too. */
async function load(name: string): Promise<IconNode | undefined> {
  const { default: chunks } = await import('lucide-react/dynamicIconImports');
  if (!Object.hasOwn(chunks, name)) return undefined;
  const { __iconData } = await chunks[name as IconName]();
  loaded.set(name, __iconData.node);
  return __iconData.node;
}

/**
 * A Lucide icon by its name on lucide.dev, loaded from its own chunk on first use, so the client
 * does not carry every icon. Nothing while it loads or when no icon has the name.
 */
export function LucideIcon({
  name,
  ...props
}: { name: string } & Omit<ComponentProps<typeof Icon>, 'iconNode' | 'icon'>) {
  const [node, setNode] = useState(() => loaded.get(name));
  useEffect(() => {
    const known = loaded.get(name);
    if (known) return setNode(known);
    let current = true;
    void load(name).then((node) => current && setNode(node));
    return () => {
      current = false;
    };
  }, [name]);
  return node ? <Icon iconNode={node} {...props} /> : null;
}

/** A `diffle-icon`: as tall as its text, in its colour or a tone; its box holds the place while it loads. */
export function TourIcon({ name, tone }: { name: string; tone?: string }) {
  return (
    <span className="tour-icon" data-tone={tone} aria-hidden>
      <LucideIcon name={name} size="1em" />
    </span>
  );
}
