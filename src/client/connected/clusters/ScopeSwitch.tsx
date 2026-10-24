import { useStore } from '@/client/store.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';

// The tree header is an `@container`: below 15rem the count is already gone, so the segments tighten too and
// "All files" drops to "All" (its accessible name stays whole), leaving the un-view button in reach.
const NARROW = '@max-[15rem]:px-1';

/** The tree's scope: Changed, All files, or the changed files grouped into feature clusters. */
export function ScopeSwitch() {
  const scope = useStore((s) => s.treeScope);
  const setScope = useStore((s) => s.setTreeScope);
  return (
    <SegmentedControl>
      <ToggleButton selected={scope === 'changed'} className={NARROW} onClick={() => setScope('changed')}>
        Changed
      </ToggleButton>
      <ToggleButton
        selected={scope === 'all'}
        aria-label="All files"
        className={NARROW}
        onClick={() => setScope('all')}
      >
        All<span className="@max-[15rem]:hidden"> files</span>
      </ToggleButton>
      <ToggleButton
        selected={scope === 'connected'}
        title="Group changed files into feature clusters (gC)"
        className={NARROW}
        onClick={() => setScope('connected')}
      >
        Connected
      </ToggleButton>
    </SegmentedControl>
  );
}
