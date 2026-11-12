import { Icon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useHost } from '@/client/tour/host/host.js';

/**
 * A Lucide icon by its name on lucide.dev, as the host has it. Nothing while it loads or when no
 * icon has the name.
 */
export function LucideIcon({
  name,
  ...props
}: { name: string } & Omit<ComponentProps<typeof Icon>, 'iconNode' | 'icon'>) {
  const node = useHost().useIcon(name);
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
