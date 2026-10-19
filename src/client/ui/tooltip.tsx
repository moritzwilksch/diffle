import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '@/client/lib/utils';

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

/**
 * Tooltip skin. `anchor` may be a virtual element, so a tip can hang from a box that outlives its
 * element. Base UI sets no role on the popup, and the tests and screen readers look for one.
 */
function TooltipContent({
  className,
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  anchor,
  collisionPadding,
  positionMethod,
  children,
  ...props
}: Omit<TooltipPrimitive.Popup.Props, 'className'> & {
  className?: string;
} & Pick<
    TooltipPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'anchor' | 'collisionPadding' | 'positionMethod' | 'side' | 'sideOffset'
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
        positionMethod={positionMethod}
        side={side}
        sideOffset={sideOffset}
        // Above every other layer (dialogs, toasts, the z-100 LSP popover): a tip names what is under the pointer.
        className="z-110"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          role="tooltip"
          className={cn(
            'rounded-lg border border-border bg-canvas px-3 py-2 text-[0.75rem] shadow-[0_0.5rem_1.5rem_rgba(0,_0,_0,_0.18)]',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent };
