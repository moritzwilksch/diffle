import { Network } from 'lucide-react';
import type { ViewDef } from '@/client/views/state.js';
import { lspBlocker } from '@/shared/lsp.js';
import { GraphDetails } from './details/GraphDetails.js';
import { GRAPH_HELP } from './help.js';
import { GRAPH_PASSES, graphKeys, openFind } from './keys.js';
import { enterGraph, graphPlace, leaveGraph, useGraph } from './state.js';
import { GraphView } from './GraphView.js';

/** The change graph: changed symbols and the code using them, which needs the language servers. */
export const graphView: ViewDef = {
  id: 'graph',
  label: 'Graph',
  icon: Network,
  title: 'Changed symbols and the code using them (M)',
  Main: GraphView,
  Side: GraphDetails,
  help: GRAPH_HELP,
  panelLabel: 'details panel',
  panelWidth: '21.25rem',
  blocked: (s) => lspBlocker(s.lsp, s.snapshot),
  enter: enterGraph,
  leave: leaveGraph,
  place: graphPlace,
  keys: graphKeys,
  passes: GRAPH_PASSES,
  escape(inField) {
    const graph = useGraph.getState();
    // An open find closes first, even from its own field.
    if (graph.find != null) {
      graph.closeFind();
      return true;
    }
    if (inField) return false;
    graph.deselect();
    return true;
  },
  find: openFind,
  pickFile: (path) => useGraph.getState().focusFile(path),
};
