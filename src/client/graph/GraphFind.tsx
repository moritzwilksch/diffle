import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '@/client/ui/Button.js';
import { findMatches, useGraph } from './state.js';

/**
 * The graph's find, top left over the canvas while open (`/` or Ctrl/⌘+F): it matches box names as
 * typed, selecting the first. Enter hands the keys back to the graph, where n / N step through the
 * matches, as they do through a search in the diff. Escape closes it.
 */
export function GraphFind() {
  const find = useGraph((s) => s.find);
  const view = useGraph((s) => s.view);
  const selected = useGraph((s) => s.selected);
  if (find == null) return null;
  const matches = findMatches(view, find);
  const at = matches.indexOf(selected ?? '');
  const graph = useGraph.getState();
  return (
    <div
      role="search"
      className="absolute top-3 left-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface py-0.5 pr-0.5 pl-2 shadow-card"
    >
      <Search size="0.875rem" className="shrink-0 text-muted" />
      <input
        autoFocus
        value={find}
        onChange={(e) => graph.setFind(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (matches.length && at < 0) graph.stepFind(1);
          e.currentTarget.blur();
        }}
        placeholder="Find a box… (Enter, then n / N)"
        aria-label="Find in the graph"
        className="w-44 border-0 bg-transparent px-1 py-1 text-[0.8125rem] text-foreground outline-none placeholder:text-muted"
      />
      <span className="min-w-[4.5rem] text-right font-mono text-[0.75rem] text-muted tabular-nums">
        {!find.trim() ? '' : matches.length ? `${at < 0 ? '–' : at + 1} / ${matches.length}` : 'No matches'}
      </span>
      <Button
        variant="ghost"
        icon
        disabled={!matches.length}
        onClick={() => graph.stepFind(-1)}
        title="Previous (N)"
        aria-label="Previous match"
      >
        <ChevronUp size="0.875rem" />
      </Button>
      <Button
        variant="ghost"
        icon
        disabled={!matches.length}
        onClick={() => graph.stepFind(1)}
        title="Next (n)"
        aria-label="Next match"
      >
        <ChevronDown size="0.875rem" />
      </Button>
      <Button variant="ghost" icon onClick={graph.closeFind} title="Close (Esc)" aria-label="Close find">
        <X size="0.875rem" />
      </Button>
    </div>
  );
}
