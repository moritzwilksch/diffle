import { focusReview } from '@/client/keyboard/useKeymap.js';
import { useStore } from '@/client/store.js';
import type { ClusterRow } from './rows.js';

/** One group of the Connected list: the title leads, the folder follows muted and truncates from its start. */
export function ClusterRowButton({ row }: { row: ClusterRow }) {
  const focusCluster = useStore((s) => s.focusCluster);
  return (
    <button
      type="button"
      aria-current={row.focused ? 'true' : undefined}
      aria-label={row.ariaLabel}
      title={row.title}
      onClick={() => {
        focusCluster(row.focus);
        requestAnimationFrame(focusReview);
      }}
      // The app resets no platform button styling, so the fill and the three other borders are cleared here.
      className={`flex w-full cursor-pointer items-center gap-2 border-0 border-l-2 py-1 pr-2.5 pl-2 text-left [transition:background-color_160ms_ease,color_160ms_ease] motion-reduce:transition-none ${
        row.focused
          ? 'border-accent bg-raised text-foreground'
          : 'border-transparent bg-transparent text-muted hover:bg-hover hover:text-foreground'
      }`}
    >
      <span aria-hidden className="w-4 flex-none text-right tabular-nums">
        {row.index}
      </span>
      <span
        className={`min-w-0 truncate font-medium ${row.index === null ? '' : 'text-foreground'} ${row.folder ? 'max-w-[62%] flex-none' : 'flex-1'}`}
      >
        {row.label}
      </span>
      {row.folder && (
        <span className="min-w-0 flex-1 truncate text-left text-[0.9em] text-muted [direction:rtl]">
          <bdi>{row.folder}</bdi>
        </span>
      )}
      {row.count !== null && <span className="flex-none tabular-nums">{row.count}</span>}
      {row.context > 0 && (
        <span
          className="flex-none text-muted tabular-nums"
          title={`${row.context} unchanged ${row.context === 1 ? 'file calls' : 'files call'} into this cluster`}
        >
          +{row.context}
        </span>
      )}
    </button>
  );
}
