import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from '@/client/lib/utils';

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/**
 * Modal surface over a dimmed backdrop. Base UI owns the focus trap, Escape, and outside press (all
 * report through `Dialog`'s `onOpenChange`); the viewport centres the popup without a transform, which
 * would soften its text.
 */
function DialogContent({
  className,
  children,
  ...props
}: Omit<DialogPrimitive.Popup.Props, 'className'> & { className?: string }) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/35" />
      <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center">
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            'w-140 max-w-[95vw] rounded-[0.625rem] border border-border bg-canvas p-4 shadow-[0_1rem_3rem_rgba(0,0,0,0.3)] outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

export { Dialog, DialogContent };
