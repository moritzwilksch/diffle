import { Dialog } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { useStore } from '../store.js';

type Row = [keys: string, action: string];
export type HelpSection = { title: string; rows: Row[] };

/**
 * Shortcut groups rendered by the help overlay, one array per column. Every bound key appears exactly once.
 * Columns are explicit because CSS multi-column overflows into a clipped third column once the dialog height is capped.
 * Every row renders on one line, so descriptions stay short.
 */
export const COLUMNS: HelpSection[][] = [
  [
    {
      title: 'Move',
      rows: [
        ['j / k  or  ↓ / ↑', 'next / previous line'],
        ['{n}j / {n}k', 'n lines down / up'],
        ['Ctrl+d / Ctrl+u', 'half a page down / up'],
        ['Ctrl+o / Ctrl+i', 'jump back / forward in history'],
        ['←  or  ⌘/Ctrl+Shift+e  /  →', 'focus the file tree / back to the diff'],
        ['V, then j / k', 'extend a block selection'],
      ],
    },
    {
      title: 'Files and hunks',
      rows: [
        ['J / K', 'next / previous file'],
        ['gg / G', 'first / last file'],
        ['{n}gg / {n}G', 'line n of the current file'],
        ['] / [   n / N', 'next / previous hunk (n / N follow matches while searching)'],
        ['v', 'toggle viewed on the current file'],
        ['zo / zc', 'expand / collapse the current file (zo loads a large diff)'],
        ['zO / zC', 'open / close all files'],
        ['F', 'view the current file whole; Ctrl+o returns'],
      ],
    },
    {
      title: 'Comments',
      rows: [
        ['c', 'comment on the current line or selection'],
        ['e', 'edit the newest message of the thread under the cursor'],
        ['dd', 'delete the thread under the cursor'],
        ['R', 'resolve / reopen the thread under the cursor'],
        ['yy or Y', 'copy all comments'],
      ],
    },
  ],
  [
    {
      title: 'Search',
      rows: [
        ['/', 'search the current file, then n / N between matches'],
        ['g/', 'search the diff (scope button: file / diff / codebase)'],
        ['gf', 'filter the file tree by name (or / in the tree)'],
        ['w / b', 'focus the next / previous symbol on the line'],
        ['0 / $', 'focus the first / last symbol on the line'],
        ['* / #', 'next / previous occurrence of the focused word'],
      ],
    },
    {
      title: 'Code intelligence (language server)',
      rows: [
        ['hover a symbol  or  gh', 'signature and docs tooltip (gh: focused word); Esc closes'],
        ['click a symbol', 'definition / type definition / references popover'],
        ['gd  or  ⌘/Ctrl+click', 'go to the definition of the hovered symbol'],
        ['gy', 'go to the definition of the hovered symbol’s type'],
        ['gA', 'list references; j / k, Enter to jump, n / N to step'],
        ['gs / gS', 'symbols in the current file / across the repository'],
      ],
    },
    {
      title: 'View',
      rows: [
        ['zz', 'scroll the current line to eye level'],
        ['zt / zb', 'scroll the current line to the top / bottom'],
        ['s', 'toggle split / unified'],
        ['t', 'cycle theme'],
        ['⌘/Ctrl+b', 'toggle the file tree (Shift: comments panel)'],
        ['m, then 1–4', 'open the mode picker and choose an entry'],
      ],
    },
    {
      title: 'General',
      rows: [
        ['?', 'toggle this help'],
        ['Esc', 'close composer, search, or menu; clear selection'],
      ],
    },
  ],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  if (!open) return null;
  return (
    <Dialog
      label="Keyboard shortcuts"
      onClose={() => setOpen(false)}
      className="w-max max-w-[96vw] p-0 max-h-[calc(100vh_-_2rem)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4.5 pt-3 pb-2.5 border-b border-b-border">
        <h3 className="m-0 text-[0.9375rem]">Keyboard shortcuts</h3>
        <Button onClick={() => setOpen(false)}>Close</Button>
      </div>
      <div className="overflow-auto px-4.5 pt-2.5 pb-3.5 grid grid-cols-[auto_auto] gap-x-10 items-start text-[0.75rem] whitespace-nowrap">
        {COLUMNS.map((sections, col) => (
          <div key={col} className="grid grid-cols-[max-content_1fr] gap-x-3 content-start">
            {sections.map((section) => (
              <section className="grid grid-cols-subgrid col-span-full mb-2.5 last:mb-0" key={section.title}>
                <h4 className="col-span-full m-0 mb-0.5 text-[0.75rem] font-semibold text-muted">{section.title}</h4>
                {section.rows.map(([k, a]) => (
                  <div key={k} className="grid grid-cols-subgrid col-span-full items-baseline leading-[1.7]">
                    <span className="inline-flex gap-1.5">
                      {k.split(/\s{2,}/).map((part, i) => (
                        <kbd key={i}>{part}</kbd>
                      ))}
                    </span>
                    <span>{a}</span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
