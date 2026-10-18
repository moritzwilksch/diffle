import { useMemo, type ComponentProps } from 'react';
import { Tooltip, TooltipContent } from '@/ui/tooltip';

/** Space between the anchor and the tip. */
const GAP = 6;
/** Keep the tip this far inside the viewport's edges. */
const EDGE = 8;

/** Viewport box a tip hangs from. */
export interface TipAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** The box as a positioning anchor; unlike an element, it stays put after the element it was measured from is gone. */
function boxAnchor({ left, top, bottom }: TipAnchor) {
  const rect = { x: left, y: top, left, top, bottom, right: left, width: 0, height: bottom - top };
  return { getBoundingClientRect: () => rect };
}

/**
 * Tooltip box below its anchor, above it near the bottom edge, clamped to the viewport's sides. It is
 * shown for as long as it is rendered: the caller decides when a tip exists.
 */
export function TipSurface({
  anchor,
  ...props
}: { anchor: TipAnchor } & Omit<ComponentProps<typeof TooltipContent>, 'anchor'>) {
  const virtual = useMemo(() => boxAnchor(anchor), [anchor]);
  return (
    <Tooltip open>
      <TooltipContent
        anchor={virtual}
        side="bottom"
        align="start"
        sideOffset={GAP}
        collisionPadding={EDGE}
        positionMethod="fixed"
        {...props}
      />
    </Tooltip>
  );
}
