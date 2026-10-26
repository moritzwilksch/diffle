import { FileDiff } from 'lucide-react';
import { defineViews } from '@/client/views/state.js';

/** Defines a bare diff view, for tests that render the header or drive the keymap without the app's registry. */
export function defineDiffStub(): void {
  defineViews([
    {
      id: 'diff',
      label: 'Diff',
      icon: FileDiff,
      title: 'The diff (M)',
      Main: () => null,
      Side: () => null,
      help: [],
      panelLabel: 'comments panel',
      panelWidth: '21.25rem',
    },
  ]);
}
