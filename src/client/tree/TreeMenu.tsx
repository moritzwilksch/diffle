import type { ContextMenuAnchorRect } from '@pierre/trees';
import { Check, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, Network } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGraph } from '@/client/graph/state.js';
import { countViewed, filesUnder, isCollapsed, isViewed } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';

/** Flips a directory as one: all viewed becomes none, anything less becomes all. */
export function toggleDirectoryViewed(dir: string) {
  const s = useStore.getState();
  const files = filesUnder(s.snapshot?.changed ?? [], dir);
  void s.setViewedMany(
    files.map((f) => f.path),
    !files.every((f) => isViewed(s, f)),
  );
}

const MENU =
  'fixed z-50 min-w-64 rounded-[0.625rem] border border-border bg-canvas p-1.5 shadow-[0_0.625rem_1.875rem_rgba(0,_0,_0,_0.18)]';
/** The menu's distance from the viewport's edges, and from the pointer, as native menus keep. */
const EDGE = 8;
const GAP = 2;
const MENU_ITEM =
  'grid min-h-8.5 w-full grid-cols-[1.125rem_1fr_auto_1.5rem] items-center gap-2.5 rounded-[0.4375rem] border-0 bg-transparent px-2.5 py-1.75 text-left font-sans text-[0.8125rem] leading-[1.3] text-foreground hover:bg-hover [&_kbd]:ml-1 [&_kbd]:justify-self-end [&_kbd]:text-muted [&>svg]:text-muted';

/**
 * Right-click menu on a tree row: viewed and collapse toggles for changed files; for directories, a
 * viewed toggle and the graph of their changes alone.
 */
export function TreeMenu({
  path,
  kind,
  anchor,
  close,
}: {
  path: string;
  kind: 'file' | 'directory';
  anchor: ContextMenuAnchorRect;
  close: () => void;
}) {
  if (kind === 'directory') return <DirectoryMenu path={path} anchor={anchor} close={close} />;
  return <FileMenu path={path} anchor={anchor} close={close} />;
}

/** Where the last right-click in the tree landed, and when: the menu opens there. */
let pointer: { x: number; y: number; at: number } | null = null;
/** A right-click this recent opened the menu; an older one was before a keyboard or button open. */
const POINTER_MS = 500;

/** Records right-clicks in `el` for the menu to open at; returns the cleanup. */
export function trackMenuPointer(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return;
  const record = (e: MouseEvent) => {
    pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  el.addEventListener('contextmenu', record, true);
  return () => el.removeEventListener('contextmenu', record, true);
}

/**
 * Where the menu box goes, as a native context menu opens: its top-left corner just past the
 * pointer, flipped to the pointer's left or above it where the viewport ends. Opened without a
 * right-click, it hangs under its row.
 */
function Floating({ anchor, children }: { anchor: ContextMenuAnchorRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at] = useState(() =>
    pointer && performance.now() - pointer.at < POINTER_MS
      ? { x: pointer.x, y: pointer.y }
      : { x: anchor.left, y: anchor.bottom },
  );
  const [style, setStyle] = useState({ left: at.x + GAP, top: at.y + GAP });
  useLayoutEffect(() => {
    const menu = ref.current?.getBoundingClientRect();
    if (!menu) return;
    const right = at.x + GAP + menu.width <= innerWidth - EDGE;
    const below = at.y + GAP + menu.height <= innerHeight - EDGE;
    setStyle({
      left: right ? at.x + GAP : Math.max(EDGE, at.x - GAP - menu.width),
      top: below ? at.y + GAP : Math.max(EDGE, at.y - GAP - menu.height),
    });
  }, [at]);
  // In the body, above every pane: inside the sidebar, the graph beside it painted over the menu. The
  // root attribute tells the tree a press in it is a press in its menu, not one that closes it.
  return createPortal(
    <div ref={ref} className={MENU} style={style} data-file-tree-context-menu-root="true">
      {children}
    </div>,
    document.body,
  );
}

type MenuProps = { path: string; anchor: ContextMenuAnchorRect; close: () => void };

function DirectoryMenu({ path, anchor, close }: MenuProps) {
  const snapshot = useStore((s) => s.snapshot);
  const viewed = useStore((s) => s.viewed);
  const config = useStore((s) => s.config);
  const files = useMemo(() => filesUnder(snapshot?.changed ?? [], path), [snapshot, path]);
  if (!files.length) return null;
  const all = countViewed({ viewed, config }, files) === files.length;
  return (
    <Floating anchor={anchor}>
      <Button
        className={MENU_ITEM}
        onClick={() => {
          toggleDirectoryViewed(path);
          close();
        }}
      >
        {all ? <EyeOff size="0.875rem" /> : <Eye size="0.875rem" />}
        <span className="whitespace-nowrap">{all ? 'Mark directory not viewed' : 'Mark directory viewed'}</span>
        <span className="inline-flex items-center justify-self-end font-mono text-[0.75rem] leading-[normal] text-muted">
          {files.length}
        </span>
        <span />
      </Button>
      <Button
        className={MENU_ITEM}
        onClick={() => {
          useGraph.getState().showScope(path.replace(/\/$/, ''));
          close();
        }}
      >
        <Network size="0.875rem" />
        <span className="whitespace-nowrap">Show in graph</span>
        <span />
        <span />
      </Button>
    </Floating>
  );
}

function FileMenu({ path, anchor, close }: MenuProps) {
  const file = useStore((s) => s.snapshot?.changed.find((f) => f.path === path));
  const viewed = useStore((s) => (file ? isViewed(s, file) : false));
  const collapsed = useStore((s) => isCollapsed(s, path));
  const setViewed = useStore((s) => s.setViewed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const openFile = useStore((s) => s.openFile);
  return (
    <Floating anchor={anchor}>
      {file ? (
        <>
          <Button
            className={MENU_ITEM}
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
            className={MENU_ITEM}
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
          className={MENU_ITEM}
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
    </Floating>
  );
}
