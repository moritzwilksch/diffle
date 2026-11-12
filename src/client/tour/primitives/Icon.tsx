import { CircleQuestionMark, type LucideIcon as Lucide, type LucideProps } from 'lucide-react';
import { createElement, useEffect, useState } from 'react';

/**
 * A Lucide icon by its name on lucide.dev, loaded on first use. Nothing while it loads; a name no
 * icon has draws a placeholder, so the reviewer sees what the agent wrote instead of a gap.
 */
export function LucideIcon({ name, ...props }: { name: string } & LucideProps) {
  const icon = useIcon(name);
  if (icon === undefined) return null;
  if (icon) return createElement(icon, props);
  // An SVG `<title>`, not a `title` attribute: an icon in a diagram is SVG, which shows only the child.
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

/** Each name looked up so far, null when no icon has it, so a later mount draws it at once. */
const loaded = new Map<string, Lucide | null>();

/** The icon `name`, from the one chunk holding every icon; null when no icon has the name. */
async function loadIcon(name: string): Promise<Lucide | null> {
  const known = loaded.get(name);
  if (known !== undefined) return known;
  const { iconNamed } = await import('./icons.js');
  const icon = iconNamed(name);
  loaded.set(name, icon);
  return icon;
}

/** An icon loaded on first use, so the main bundle carries none: undefined while it loads. */
function useIcon(name: string): Lucide | null | undefined {
  const [icon, setIcon] = useState(() => loaded.get(name));
  useEffect(() => {
    let current = true;
    void loadIcon(name).then((icon) => current && setIcon(icon));
    return () => {
      current = false;
    };
  }, [name]);
  return icon;
}
