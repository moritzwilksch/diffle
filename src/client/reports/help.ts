import type { HelpSection } from '@/client/views/state.js';

/** The reports' shortcuts: their own keys, then those they leave to the review. */
export const REPORTS_HELP: HelpSection[][] = [
  [
    {
      title: 'Reports',
      rows: [
        ['j / k', 'next / previous block'],
        ['J / K   ] / [', 'next / previous report'],
        ['Enter', 'open the block’s line in the diff'],
        ['c', 'comment on the block’s line in the diff'],
        ['click a report', 'show it; its log opens from the header'],
      ],
    },
  ],
  [
    {
      title: 'Review',
      rows: [
        ['gr', 'back to the diff'],
        ['M', 'the change graph'],
        ['Ctrl+o / Ctrl+i', 'jump back / forward in history'],
        ['⌘/Ctrl+b', 'toggle the file tree (Shift: reports list)'],
        ['t', 'cycle theme'],
        ['o', 'GitHub repository and pull request'],
        ['m, then 1–6', 'open the mode picker and choose an entry'],
      ],
    },
    {
      title: 'General',
      rows: [['?', 'toggle this help']],
    },
  ],
];
