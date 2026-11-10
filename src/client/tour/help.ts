import type { HelpSection } from '@/client/views/state.js';

/** The tour's shortcuts: its own keys, then those it leaves to the review. */
export const TOUR_HELP: HelpSection[][] = [
  [
    {
      title: 'Tour',
      rows: [
        ['n / p', 'next / previous step'],
        ['click a card or a step', 'go to that step'],
        ['0  + / -', 'fit the tour / zoom in / out'],
        ['scroll / pinch', 'pan / zoom the tour'],
        ['click a line range or a file', 'open it in the diff'],
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
        ['⌘/Ctrl+b', 'toggle the file tree (Shift: steps panel)'],
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
