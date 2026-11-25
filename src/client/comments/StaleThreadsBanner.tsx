import { AlertTriangle, Trash2 } from 'lucide-react';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { ButtonLabel } from '@/client/ui/ButtonLabel.js';
import { useConfirm } from '@/client/useConfirm.js';

export function StaleThreadsBanner({ count }: { count: number }) {
  const deleteStaleThreads = useStore((s) => s.deleteStaleThreads);
  const remove = useConfirm(() => void deleteStaleThreads());
  return (
    <div className="flex items-center gap-1.5 border-b border-b-border px-2.5 py-1 text-[0.75rem] text-warn">
      <span
        className="inline-flex cursor-default items-center gap-1.5"
        title="Stale threads no longer point into the diff: their text changed or left the changed lines"
      >
        <AlertTriangle size="0.75rem" />
        {count} stale
      </span>
      <Button
        variant="ghost"
        danger
        feedback={remove.armed ? 'confirm' : undefined}
        className="ml-auto gap-1 px-1.5 py-px text-[0.75rem] leading-[1.2]"
        aria-label={remove.armed ? 'Delete all stale threads? Click again to confirm' : undefined}
        onClick={remove.fire}
      >
        <Trash2 size="0.75rem" />
        <ButtonLabel text={remove.armed ? 'Delete all stale?' : 'Delete all stale'} />
      </Button>
    </div>
  );
}
