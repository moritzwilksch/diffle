import { FileDiff, Network } from 'lucide-react';
import { useStore } from '@/client/store.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';
import { lspBlocker } from '@/shared/lsp.js';
import { useGraph } from './state.js';

/** Diff or graph in the main pane; the graph needs the language servers, so it names why it cannot open. */
export function ViewSwitch() {
  const open = useGraph((s) => s.open);
  const blocked = useStore((s) => lspBlocker(s.lsp, s.snapshot));
  const toggle = () => useGraph.getState().toggle();
  return (
    <SegmentedControl>
      <ToggleButton selected={!open} onClick={() => open && toggle()} aria-label="Diff" title="The diff (M)">
        <FileDiff size="0.875rem" /> <span className="max-xl:hidden">Diff</span>
      </ToggleButton>
      <ToggleButton
        selected={open}
        disabled={!open && blocked != null}
        onClick={() => !open && toggle()}
        aria-label="Graph"
        title={blocked ?? 'Changed symbols and the code using them (M)'}
      >
        <Network size="0.875rem" /> <span className="max-xl:hidden">Graph</span>
      </ToggleButton>
    </SegmentedControl>
  );
}
