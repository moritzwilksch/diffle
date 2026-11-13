import { CircleQuestionMark, type LucideProps } from 'lucide-react';
import { useHost } from '@/client/tour/host/host.js';

/**
 * A Lucide icon by its name on lucide.dev, as the host has it. Nothing while it loads; a name no
 * icon has draws a placeholder, so the reviewer sees what the agent wrote instead of a gap.
 */
export function LucideIcon({ name, ...props }: { name: string } & LucideProps) {
  const draw = useHost().useIcon(name);
  if (draw === undefined) return null;
  if (draw) return draw(props);
  // An SVG `<title>`, not a `title` attribute: an icon in a diagram is SVG, which shows only the
  // child, and an exported tour has no tooltip host to read the attribute.
  return (
    <CircleQuestionMark {...props}>
      <title>{`Unknown icon "${name}"`}</title>
    </CircleQuestionMark>
  );
}

/** A `diffle-icon`: as tall as its text, in its colour or a tone; its box holds the place while it loads. */
export function TourIcon({ name, tone }: { name: string; tone?: string }) {
  return (
    <span className="tour-icon" data-tone={tone} aria-hidden>
      <LucideIcon name={name} size="1em" />
    </span>
  );
}
