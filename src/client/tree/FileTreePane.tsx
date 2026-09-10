import { ToggleButton } from '../ui/ToggleButton.js';
import { Button } from '../ui/Button.js';
import type { GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { Check, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangedFile, ViewedState } from '../../shared/protocol.js';
import { focusReview } from '../keyboard/useKeymap.js';
import { countViewed, isCollapsed, isViewed, viewedState } from '../model.js';
import { remPx } from '../scale.js';
import { useStore } from '../store.js';
import { useConfirm } from '../useConfirm.js';
import type { SyncKeys } from './sync.js';
import { decorationKey, directoriesOf, expandedAfterReset, statusKey, syncStep, toGitStatus } from './sync.js';

type Scope = 'changed' | 'all';

// The decoration lane holds one span of colored text parts: the file's +/− counts, then
// the viewed mark as a glyph (the lane takes either text or one icon, not both).
const MARK: Record<ViewedState, { glyph: string; color: string; title: string }> = {
  viewed: { glyph: '✓', color: 'var(--add)', title: 'Viewed · click or v to toggle' },
  unviewed: { glyph: '○', color: 'var(--fg-2)', title: 'Not viewed · click or v to toggle' },
  restale: { glyph: '◐', color: 'var(--warn)', title: 'Changed since you viewed it · click or v to mark viewed again' },
};

// Injected into the tree's shadow root: parts are flex items, so spacing is a gap (leading
// spaces would collapse). The lane grows but never shrinks, so it sits flush against the
// git lane -- the viewed marks line up in a column -- and the file name ellipsizes first.
const LANE_CSS = `
[data-item-section="decoration"] { flex: 1 0 auto; overflow: visible; }
[data-item-section="decoration"] > span { gap: 0.375rem; overflow: visible; font-variant-numeric: tabular-nums; }
[data-item-section="decoration"] > span > span:last-child { min-width: 1ch; text-align: center; }
`;

function rowDecoration(f: ChangedFile, state: ViewedState) {
  const parts: { text: string; color?: string }[] = [];
  if (f.additions > 0) parts.push({ text: `+${f.additions}`, color: 'var(--add)' });
  if (f.deletions > 0) parts.push({ text: `−${f.deletions}`, color: 'var(--del)' });
  const mark = MARK[state];
  parts.push({ text: mark.glyph, color: mark.color });
  const counts = f.binary ? 'binary' : `+${f.additions} −${f.deletions}`;
  return { text: parts.map((p) => p.text).join(' '), parts, title: `${counts} · ${mark.title}` };
}

export function FileTreePane() {
  const snapshot = useStore((s) => s.snapshot);
  const openFile = useStore((s) => s.openFile);
  const [scope, setScope] = useState<Scope>('changed');
  const unviewAll = useStore((s) => s.unviewAll);
  const viewed = useStore((s) => s.viewed);
  const config = useStore((s) => s.config);
  // Memoised: a raw selector would rescan every changed file on each store update, including cursor moves.
  const viewedCount = useMemo(
    () => (snapshot ? countViewed({ viewed, config }, snapshot.changed) : 0),
    [snapshot, viewed, config],
  );
  const unview = useConfirm(() => void unviewAll());

  const paths = useMemo(() => {
    if (!snapshot) return [] as string[];
    return scope === 'changed' ? snapshot.changed.map((f) => f.path) : snapshot.tree;
  }, [snapshot, scope]);

  const gitStatus = useMemo<GitStatusEntry[]>(() => snapshot?.changed.map(toGitStatus) ?? [], [snapshot]);

  const openRef = useRef(openFile);
  openRef.current = openFile;

  const { model } = useFileTree({
    paths,
    gitStatus,
    // Explicit expansion, not 'open': the library ignores `initialExpandedPaths` under 'open',
    // and the sync effect below needs it to carry collapsed folders across `resetPaths`.
    initialExpansion: 'closed',
    initialExpandedPaths: directoriesOf(paths),
    search: true,
    // The tree sizes rows and paddings in px; derive both from the root font size so it follows the app's scale.
    itemHeight: Math.round(1.875 * remPx()),
    density: remPx() / 16,
    icons: { set: 'standard' },
    unsafeCSS: LANE_CSS,
    onSelectionChange: (selected) => {
      const path = selected[0];
      // The active file is mirrored into the selection below; only a change of file is a request to open one.
      if (path && !path.endsWith('/') && path !== useStore.getState().activePath) void openRef.current(path);
    },
    // Counts and viewed mark in the decoration lane; reads live state at render time.
    // Clicks are handled below, since decorations are plain text.
    renderRowDecoration: ({ item }) => {
      if (item.kind !== 'file') return null;
      const s = useStore.getState();
      const f = s.snapshot?.changed.find((x) => x.path === item.path);
      return f ? rowDecoration(f, viewedState(s, f)) : null;
    },
  });

  // A click on the decoration toggles viewed without selecting the row. The tree renders in
  // a shadow root, so the hit test walks the composed path from the pointer target. Only the
  // decoration's own <span>s count: the lane stretches to the row's end, and a click in that
  // empty space must select the row, not toggle viewed.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const pathOfDecorationClick = (e: Event): string | null => {
      const path = e.composedPath() as HTMLElement[];
      const lane = path.findIndex((n) => n instanceof HTMLElement && n.dataset.itemSection === 'decoration');
      if (lane <= 0) return null;
      return (
        path.find((n) => n instanceof HTMLElement && n.dataset.itemPath != null && n.dataset.itemType === 'file')
          ?.dataset.itemPath ?? null
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !pathOfDecorationClick(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      const path = pathOfDecorationClick(e);
      if (!path) {
        const row = (e.composedPath() as HTMLElement[]).find(
          (n) => n instanceof HTMLElement && n.dataset.itemType === 'file',
        );
        const path = row?.dataset.itemPath;
        if (!path) return;
        // Choosing a file is the start of reading it: expand it and hand the keys to the review pane.
        // The tree focuses its row on click, so hand focus over a frame later.
        requestAnimationFrame(focusReview);
        const s = useStore.getState();
        if (isCollapsed(s, path)) s.toggleCollapsed(path);
        // Re-clicking the active file changes no selection, so `onSelectionChange` stays silent.
        if (path === s.activePath) void openRef.current(path);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const s = useStore.getState();
      const f = s.snapshot?.changed.find((x) => x.path === path);
      if (f) void s.setViewed(path, !isViewed(s, f));
    };
    el.addEventListener('pointerdown', onPointerDown, true);
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true);
      el.removeEventListener('click', onClick, true);
    };
  }, []);

  // The selected row follows the file under the cursor, so the tree always shows where the reader is.
  const activePath = useStore((s) => s.activePath);
  useEffect(() => {
    const item = model.getItem(activePath ?? '');
    if (!activePath || !item) return;
    for (const p of model.getSelectedPaths()) if (p !== activePath) model.getItem(p)?.deselect();
    item.select();
    model.scrollToPath(activePath);
  }, [model, activePath, paths]);

  const setTreeModel = useStore((s) => s.setTreeModel);
  useEffect(() => {
    setTreeModel(model);
    return () => setTreeModel(null);
  }, [model, setTreeModel]);

  // Keep the model in sync when the snapshot, scope, viewed marks or auto-viewed patterns change.
  // `syncStep` picks the update by content, so a save that leaves the rows alone redraws nothing.
  const keys = useMemo<SyncKeys>(
    () => ({
      paths: paths.join('\n'),
      status: statusKey(snapshot?.changed ?? []),
      decoration: snapshot ? decorationKey({ viewed, config }, snapshot.changed) : '',
    }),
    [paths, snapshot, viewed, config],
  );
  const synced = useRef<SyncKeys | null>(null);
  useEffect(() => {
    const step = syncStep(synced.current, keys);
    synced.current = keys;
    switch (step) {
      case 'reset':
        model.resetPaths(paths, { initialExpandedPaths: expandedAfterReset(model, paths) });
        model.setGitStatus(gitStatus); // a reset draws every row afresh
        break;
      case 'status':
        model.setGitStatus(gitStatus); // redraws the rows, decorations included
        break;
      case 'decoration':
        // `setGitStatus` no-ops while its signature is unchanged; re-applying the composition redraws the rows.
        model.setComposition(model.getComposition());
        break;
      case 'none':
        break;
    }
  }, [model, keys, paths, gitStatus]);

  return (
    <aside className="tree-theme flex min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-b-border px-2.5 py-1.5 text-muted [&_button]:flex-none [&_button]:whitespace-nowrap">
        <div className="flex overflow-hidden rounded-md border border-border">
          <ToggleButton selected={scope === 'changed'} onClick={() => setScope('changed')}>
            Changed
          </ToggleButton>
          <ToggleButton selected={scope === 'all'} onClick={() => setScope('all')}>
            All files
          </ToggleButton>
        </div>
        <span className="ml-auto">{paths.length}</span>
        <Button
          variant="ghost"
          danger={unview.armed}
          icon={!unview.armed}
          feedback={unview.armed ? 'confirm' : undefined}
          disabled={viewedCount === 0}
          title={
            unview.armed
              ? 'Click again to mark all files not viewed'
              : `Mark all ${viewedCount} viewed file(s) not viewed`
          }
          onClick={unview.fire}
        >
          <EyeOff size="0.875rem" />
          {unview.armed && 'Un-view all?'}
        </Button>
      </div>
      <div className="min-h-0 flex-1" ref={bodyRef}>
        <FileTree
          model={model}
          className="h-full"
          renderContextMenu={(item, ctx) => <TreeMenu path={item.path} kind={item.kind} close={ctx.close} />}
        />
      </div>
    </aside>
  );
}

/** Right-click menu on a tree row: viewed and collapse toggles for changed files. */
function TreeMenu({ path, kind, close }: { path: string; kind: 'file' | 'directory'; close: () => void }) {
  const file = useStore((s) => s.snapshot?.changed.find((f) => f.path === path));
  const viewed = useStore((s) => (file ? isViewed(s, file) : false));
  const collapsed = useStore((s) => isCollapsed(s, path));
  const setViewed = useStore((s) => s.setViewed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const openFile = useStore((s) => s.openFile);
  if (kind !== 'file') return null;
  return (
    <div className="static top-[calc(100%_+_0.375rem)] left-0 z-20 min-w-95 rounded-[0.625rem] border border-border bg-canvas p-1.5 shadow-[0_0.625rem_1.875rem_rgba(0,_0,_0,_0.18)]">
      {file ? (
        <>
          <Button
            className="grid min-h-8.5 w-full grid-cols-[1.125rem_1fr_auto_1.5rem] items-center gap-2.5 rounded-[0.4375rem] border-0 bg-transparent px-2.5 py-1.75 text-left font-sans text-[0.8125rem] leading-[1.3] text-foreground hover:bg-hover [&_kbd]:ml-1 [&_kbd]:justify-self-end [&_kbd]:text-muted [&>svg]:text-muted"
            onClick={() => {
              void setViewed(path, !viewed);
              close();
            }}
          >
            {viewed ? <EyeOff size="0.875rem" /> : <Eye size="0.875rem" />}
            <span className="whitespace-nowrap">{viewed ? 'Mark not viewed' : 'Mark viewed'}</span>
            <span className="inline-flex items-center justify-self-end font-mono text-[0.75rem] leading-[normal] text-muted">
              {viewed ? '' : <Check size="0.75rem" />}
            </span>
            <kbd>v</kbd>
          </Button>
          <Button
            className="grid min-h-8.5 w-full grid-cols-[1.125rem_1fr_auto_1.5rem] items-center gap-2.5 rounded-[0.4375rem] border-0 bg-transparent px-2.5 py-1.75 text-left font-sans text-[0.8125rem] leading-[1.3] text-foreground hover:bg-hover [&_kbd]:ml-1 [&_kbd]:justify-self-end [&_kbd]:text-muted [&>svg]:text-muted"
            onClick={() => {
              toggleCollapsed(path);
              close();
            }}
          >
            {collapsed ? <ChevronsUpDown size="0.875rem" /> : <ChevronsDownUp size="0.875rem" />}
            <span className="whitespace-nowrap">{collapsed ? 'Expand' : 'Collapse'}</span>
            <span className="inline-flex items-center justify-self-end font-mono text-[0.75rem] leading-[normal] text-muted" />
            <kbd>{collapsed ? 'zo' : 'zc'}</kbd>
          </Button>
        </>
      ) : (
        <Button
          className="grid min-h-8.5 w-full grid-cols-[1.125rem_1fr_auto_1.5rem] items-center gap-2.5 rounded-[0.4375rem] border-0 bg-transparent px-2.5 py-1.75 text-left font-sans text-[0.8125rem] leading-[1.3] text-foreground hover:bg-hover [&_kbd]:ml-1 [&_kbd]:justify-self-end [&_kbd]:text-muted [&>svg]:text-muted"
          onClick={() => {
            void openFile(path);
            close();
          }}
        >
          <Eye size="0.875rem" />
          <span className="whitespace-nowrap">Open</span>
          <span className="inline-flex items-center justify-self-end font-mono text-[0.75rem] leading-[normal] text-muted" />
          <span />
        </Button>
      )}
    </div>
  );
}
