import { BookOpen } from 'lucide-react';
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
        ['gv', 'toggle viewed on the file above'],
        ['zo / zc', 'expand / collapse the current file (zo loads a large diff)'],
        ['zO / zC', 'open / close all files'],
        ['F', 'view the current file whole; Ctrl+o returns'],
      ],
    },
    {
      title: 'Comments',
      rows: [
        ['c', 'comment on the current line or selection'],
        ['C', 'comment on the current file as a whole'],
        ['e', 'edit the newest message of the thread under the cursor'],
        ['dd', 'delete the thread under the cursor'],
        ['R', 'resolve / reopen the thread under the cursor'],
        ['yy or Y', 'copy all comments'],
        ['yp', 'copy the current file’s path'],
      ],
    },
  ],
  [
    {
      title: 'Search',
      rows: [
        ['/', 'search the current file, then n / N between matches'],
        ['g/', 'search changed files (toggle: diff + context / full file)'],
        ['⌘/Ctrl+p  or  gf', 'search files by name'],
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
        ['gd  or  ⌘/Ctrl+click', 'go to the definition, or its references from there'],
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
        ['o', 'GitHub repository and pull request'],
        ['m, then 1–6', 'open the mode picker and choose an entry'],
        ['< / >', 'older / newer commit or range-diff pair'],
      ],
    },
    {
      title: 'Iterations',
      rows: [
        ['r', 'reload once the compared refs moved'],
        ['ii', 'latest iteration vs. the one before; again: the range'],
        ['ij / ik', 'span’s lower end one iteration older / newer'],
        ['iJ / iK', 'span’s higher end one iteration older / newer'],
        ['i, then 1–9', 'compare that iteration with the latest'],
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

/** GitHub's mark (Octicons `mark-github`); Lucide ships no brand icons. */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="1rem" height="1rem" fill="currentColor" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** Icon-only link in the dialog header, the height of the Close button. */
const LINK =
  'inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground';

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  if (!open) return null;
  return (
    <Dialog
      label="Keyboard shortcuts"
      onClose={() => setOpen(false)}
      className="flex max-h-[calc(100vh_-_2rem)] w-max max-w-[96vw] flex-col overflow-hidden p-0"
    >
      <div className="flex items-center justify-between border-b border-b-border px-4.5 pt-3 pb-2.5">
        <h3 className="m-0 text-[0.9375rem]">Keyboard shortcuts</h3>
        <div className="flex items-center">
          <a className={LINK} href="https://diffle.app" target="_blank" rel="noreferrer" aria-label="Docs" title="Docs">
            <BookOpen size="1rem" aria-hidden="true" />
          </a>
          <a
            className={LINK}
            href="https://github.com/moritzwilksch/diffle"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
            title="GitHub repository"
          >
            <GithubMark />
          </a>
          <Button className="ml-2" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[auto_auto] items-start gap-x-10 overflow-auto px-4.5 pt-2.5 pb-3.5 text-[0.75rem] whitespace-nowrap">
        {COLUMNS.map((sections, col) => (
          <div key={col} className="grid grid-cols-[max-content_1fr] content-start gap-x-3">
            {sections.map((section) => (
              <section className="col-span-full mb-2.5 grid grid-cols-subgrid last:mb-0" key={section.title}>
                <h4 className="col-span-full m-0 mb-0.5 text-[0.75rem] font-semibold text-muted">{section.title}</h4>
                {section.rows.map(([k, a]) => (
                  <div key={k} className="col-span-full grid grid-cols-subgrid items-baseline leading-[1.7]">
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
