import type { HelpSection } from '@/client/views/state.js';

/** The graph's shortcuts: its own keys, then those it leaves to the review. */
export const GRAPH_HELP: HelpSection[][] = [
  [
    {
      title: 'Change graph',
      rows: [
        ['h / j / k / l', 'select the next symbol left / down / up / right'],
        ['Enter', 'open the selected symbol in the diff'],
        ['zz  double-click', 'frame the selection and its links, or fit the graph'],
        ['/  Ctrl+F', 'find a box by name; Enter, then n / N between matches'],
        ['s / d / T', 'toggle symbol nodes / dependents / tests'],
        ['0  + / -', 'fit the graph / zoom in / out'],
        ['scroll / pinch', 'pan / zoom the graph'],
        ['click a file in the tree', 'highlight and frame its boxes'],
        ['right-click a folder', 'Show in graph: only the changes under it'],
      ],
    },
  ],
  [
    {
      title: 'Review',
      rows: [
        ['M', 'back to the diff'],
        ['Ctrl+o / Ctrl+i', 'jump back / forward in history'],
        ['⌘/Ctrl+b', 'toggle the file tree (Shift: details panel)'],
        ['⌘/Ctrl+Shift+e', 'focus the file tree'],
        ['⌘/Ctrl+p', 'search files by name'],
        ['t', 'cycle theme'],
        ['o', 'GitHub repository and pull request'],
        ['m, then 1–6', 'open the mode picker and choose an entry'],
      ],
    },
    {
      title: 'General',
      rows: [
        ['?', 'toggle this help'],
        ['Esc', 'close the find, then clear the selection'],
      ],
    },
  ],
];
