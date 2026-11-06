import { FileDiff } from 'lucide-react';
import { CommentPanel } from '@/client/comments/CommentPanel.js';
import { graphView } from '@/client/graph/view.js';
import { DiffStyleSwitch } from '@/client/header/DiffStyleSwitch.js';
import { DIFF_HELP } from '@/client/keyboard/HelpOverlay.js';
import { ReviewPane } from '@/client/review/ReviewPane.js';
import { useStore } from '@/client/store.js';
import { activeView, defineViews, showView, type ViewDef } from './state.js';

/** The diff and its comments: the base view, laid out under any other so it keeps its scroll. */
const diffView: ViewDef = {
  id: 'diff',
  label: 'Diff',
  icon: FileDiff,
  title: 'The diff (M)',
  Main: ReviewPane,
  Side: CommentPanel,
  Controls: DiffStyleSwitch,
  help: DIFF_HELP,
  panelLabel: 'comments panel',
  panelWidth: '21.25rem',
};

defineViews([diffView, graphView]);
useStore.getState().registerView({
  here: () => activeView().place?.() ?? null,
  leave: () => showView('diff'),
});
