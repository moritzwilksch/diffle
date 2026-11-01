import type { HelpSection } from '@/client/views/state.js';

/** The story's shortcuts: its own keys, then those it leaves to the review. */
export const STORY_HELP: HelpSection[][] = [
  [
    {
      title: 'Story',
      rows: [
        ['j / k', 'next / previous file of the story'],
        ['n / p', 'next / previous part'],
        ['Enter', 'open the file in the diff'],
        ['v', 'mark the file viewed (Shift: the whole part)'],
        ['z', 'fold / unfold the file'],
        ['r', 'write the story, or write it again'],
        ['click a file in the tree', 'go to it in the story'],
      ],
    },
  ],
  [
    {
      title: 'Review',
      rows: [
        ['S', 'back to the diff'],
        ['M', 'the change graph'],
        ['Ctrl+o / Ctrl+i', 'jump back / forward in history'],
        ['⌘/Ctrl+b', 'toggle the file tree (Shift: comments panel)'],
        ['⌘/Ctrl+Shift+e', 'focus the file tree'],
        ['⌘/Ctrl+p', 'search files by name'],
        ['t', 'cycle theme'],
        ['?', 'this help'],
      ],
    },
  ],
];
