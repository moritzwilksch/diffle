import { Check, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff } from 'lucide-react';
import { useMemo } from 'react';
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
  'static top-[calc(100%_+_0.375rem)] left-0 z-20 min-w-95 rounded-[0.625rem] border border-border bg-canvas p-1.5 shadow-[0_0.625rem_1.875rem_rgba(0,_0,_0,_0.18)]';
const MENU_ITEM =
  'grid min-h-8.5 w-full grid-cols-[1.125rem_1fr_auto_1.5rem] items-center gap-2.5 rounded-[0.4375rem] border-0 bg-transparent px-2.5 py-1.75 text-left font-sans text-[0.8125rem] leading-[1.3] text-foreground hover:bg-hover [&_kbd]:ml-1 [&_kbd]:justify-self-end [&_kbd]:text-muted [&>svg]:text-muted';

/** Right-click menu on a tree row: viewed and collapse toggles for changed files, a viewed toggle for directories. */
export function TreeMenu({ path, kind, close }: { path: string; kind: 'file' | 'directory'; close: () => void }) {
  if (kind === 'directory') return <DirectoryMenu path={path} close={close} />;
  return <FileMenu path={path} close={close} />;
}

function DirectoryMenu({ path, close }: { path: string; close: () => void }) {
  const snapshot = useStore((s) => s.snapshot);
  const viewed = useStore((s) => s.viewed);
  const config = useStore((s) => s.config);
  const files = useMemo(() => filesUnder(snapshot?.changed ?? [], path), [snapshot, path]);
  if (!files.length) return null;
  const all = countViewed({ viewed, config }, files) === files.length;
  return (
    <div className={MENU}>
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
    </div>
  );
}

function FileMenu({ path, close }: { path: string; close: () => void }) {
  const file = useStore((s) => s.snapshot?.changed.find((f) => f.path === path));
  const viewed = useStore((s) => (file ? isViewed(s, file) : false));
  const collapsed = useStore((s) => isCollapsed(s, path));
  const setViewed = useStore((s) => s.setViewed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const openFile = useStore((s) => s.openFile);
  return (
    <div className={MENU}>
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
    </div>
  );
}
