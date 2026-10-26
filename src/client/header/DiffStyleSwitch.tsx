import { Columns2, Rows3 } from 'lucide-react';
import { useStore } from '@/client/store.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';

/** Split or unified rows in the diff. */
export function DiffStyleSwitch() {
  const diffStyle = useStore((s) => s.diffStyle);
  const setDiffStyle = useStore((s) => s.setDiffStyle);
  return (
    <SegmentedControl title="Diff layout (s)">
      <ToggleButton selected={diffStyle === 'split'} onClick={() => setDiffStyle('split')} aria-label="Split">
        <Columns2 size="0.875rem" /> <span className="max-xl:hidden">Split</span>
      </ToggleButton>
      <ToggleButton selected={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')} aria-label="Unified">
        <Rows3 size="0.875rem" /> <span className="max-xl:hidden">Unified</span>
      </ToggleButton>
    </SegmentedControl>
  );
}
