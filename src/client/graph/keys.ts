import { canvasControl } from './GraphCanvas.js';
import { type Direction, useGraph } from './state.js';

const STEPS: Record<string, Direction> = {
  h: 'left',
  ArrowLeft: 'left',
  l: 'right',
  ArrowRight: 'right',
  k: 'up',
  ArrowUp: 'up',
  j: 'down',
  ArrowDown: 'down',
};

const ZOOM_STEP = 1.25;

/** Keys the graph leaves to the review: help, theme, the mode picker, and `M` back to the diff. */
export const GRAPH_PASSES = new Set(['?', 't', 'm', 'M', 'o']);

/** The graph view's own keys; true when `e` was one. The keymap calls it only while the graph is open. */
export function graphKeys(e: KeyboardEvent): boolean {
  const graph = useGraph.getState();
  const step = STEPS[e.key];
  if (step) {
    graph.step(step);
    return true;
  }
  switch (e.key) {
    case 'Enter': {
      const node = graph.view?.graph.nodes.find((n) => n.id === graph.selected);
      if (node) graph.pick({ path: node.path, line: node.line });
      return true;
    }
    case 'f':
      graph.setFilter('files', !graph.filters.files);
      return true;
    case 'u':
      graph.setFilter('consumers', !graph.filters.consumers);
      return true;
    case 'T':
      graph.setFilter('tests', !graph.filters.tests);
      return true;
    case '0':
      canvasControl.fit();
      return true;
    case '+':
    case '=':
      canvasControl.zoom(ZOOM_STEP);
      return true;
    case '-':
      canvasControl.zoom(1 / ZOOM_STEP);
      return true;
    default:
      return false;
  }
}
