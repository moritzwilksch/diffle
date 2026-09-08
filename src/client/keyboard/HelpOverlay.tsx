import { useStore } from '../store.js';

type Row = [keys: string, action: string];
export type HelpSection = { title: string; rows: Row[] };

/**
 * Shortcut groups rendered by the help overlay, one array per column. Every bound key appears exactly once.
 * Columns are explicit because CSS multi-column overflows into a clipped third column once the dialog height is capped.
 */
export const COLUMNS: HelpSection[][] = [[
  {
    title: 'Move',
    rows: [
      ['j / k  or  ↓ / ↑', 'next / previous line'],
      ['Ctrl+d / Ctrl+u', 'half a page down / up, cursor stays at eye level'],
      ['Ctrl+o / Ctrl+i', 'jump back / forward through previous positions'],
      ['←  or  ⌘/Ctrl+Shift+e  /  →', 'focus the file tree (arrows walk files) / back to the diff'],
      ['V, then j / k', 'extend a block selection'],
    ],
  },
  {
    title: 'Files and hunks',
    rows: [
      ['J / K', 'next / previous file'],
      ['gg / G', 'first / last file'],
      ['{n}gg / {n}G', 'line n of the current file'],
      ['] / [   n / N', 'next / previous hunk (n / N follow search matches while a search is active)'],
      ['v', 'toggle viewed on the current file'],
      ['zo / zc', 'expand / collapse the current file (zo also loads a large diff)'],
      ['zO / zC', 'open / close all files'],
      ['F', 'view the current file whole; Ctrl+o or the back button return to the diff'],
    ],
  },
  {
    title: 'Comments',
    rows: [
      ['c', 'comment on the current line or selection'],
      ['e', 'edit the newest message of the thread under the cursor'],
      ['dd', 'delete the thread under the cursor'],
      ['R', 'resolve / reopen the thread under the cursor'],
      ['yy or Y / yf', 'copy all comments / comments for the current file'],
    ],
  },
], [
  {
    title: 'Search',
    rows: [
      ['/', 'search the current file’s contents, then n / N to jump between matches'],
      ['g/', 'search the diff’s file contents (the scope button cycles file / diff / full codebase)'],
      ['gf', 'filter the file tree by name (also / while the tree has focus)'],
      ['w / b', 'focus the next / previous symbol on the line (then gd / gA / * / #)'],
      ['0 / $', 'focus the first / last symbol on the line'],
      ['* / #', 'next / previous whole-word occurrence of the focused word; n / N continue that way'],
    ],
  },
  {
    title: 'Code intelligence (--lsp)',
    rows: [
      ['hover a symbol  or  gh', 'tooltip with its signature and documentation (gh: for the focused word); Esc or moving away closes it'],
      ['click a symbol', 'popover with go to definition / type definition / references'],
      ['gd  or  ⌘/Ctrl+click', 'go to the definition of the hovered symbol'],
      ['gy', 'go to the definition of the hovered symbol’s type'],
      ['gA', 'list references of the hovered symbol; j / k, Enter to jump, then n / N to step'],
      ['gs / gS', 'symbols in the current file / across the repository'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['zz', 'scroll so the current line sits at eye level, where hunk jumps land'],
      ['zt / zb', 'scroll so the current line sits near the top / bottom of the view'],
      ['s', 'toggle split / unified'],
      ['t', 'cycle theme'],
      ['⌘/Ctrl+b', 'toggle the file tree; add Shift for the comments panel'],
      ['m, then 1–5', 'open the mode picker and choose an entry'],
    ],
  },
  {
    title: 'General',
    rows: [
      ['?', 'toggle this help'],
      ['Esc', 'close composer, search, or menu; clear selection'],
    ],
  },
]];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="dialog help" role="dialog" aria-label="Keyboard shortcuts">
        <div className="help-head">
          <h3>Keyboard shortcuts</h3>
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
        <div className="help-body">
          {COLUMNS.map((sections, col) => (
            <div key={col} className="help-col">
              {sections.map((section) => (
                <section key={section.title}>
                  <h4>{section.title}</h4>
                  <table>
                    <tbody>
                      {section.rows.map(([k, a]) => (
                        <tr key={k}>
                          <td>
                            {k.split(/\s{2,}/).map((part, i) => (
                              <span key={i} style={{ marginRight: 8 }}>
                                <kbd>{part}</kbd>
                              </span>
                            ))}
                          </td>
                          <td>{a}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
