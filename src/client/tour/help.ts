import type { HelpSection } from '@/client/views/state.js';

/** The tour's shortcuts: its own keys, then those it leaves to the review. */
export const TOUR_HELP: HelpSection[][] = [
  [
    {
      title: 'Tour',
      rows: [
        ['n / p', 'next / previous section'],
        ['click a heading in the contents', 'go to it'],
        ['j / k', 'scroll the page'],
        ['d / u', 'scroll half a page'],
        ['click a line range or a file', 'open it in the diff'],
      ],
    },
    {
      title: 'Comments',
      rows: [
        ['select words, then c', 'comment on them'],
        ['Esc', 'close the comment being written'],
        ['yy or Y', 'copy all comments'],
      ],
    },
  ],
  [
    {
      title: 'Review',
      rows: [
        ['T', 'back to the diff'],
        ['M', 'the change graph'],
        ['Ctrl+o / Ctrl+i', 'jump back / forward in history'],
        ['⌘/Ctrl+b', 'toggle the file tree (Shift: contents panel)'],
        ['t', 'cycle theme'],
        ['m, then 1–6', 'open the mode picker and choose an entry'],
      ],
    },
    {
      title: 'General',
      rows: [['?', 'toggle this help']],
    },
  ],
];
