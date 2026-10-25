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
/** How soon a second `z` makes `zz`, as the review's chords wait. */
const CHORD_MS = 800;
let zAt = -Infinity;

/** Keys the graph leaves to the review: help, theme, the mode picker, and `M` back to the diff. */
export const GRAPH_PASSES = new Set(['?', 't', 'm', 'M', 'o']);

/** Ctrl/⌘+F over the graph: the browser's find cannot see boxes panned out of view, so it opens the graph's. */
export function isGraphFind(e: KeyboardEvent): boolean {
  return (
    useGraph.getState().open && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'
  );
}

/** Opens the graph's find, or takes the reader back to its field, its text selected to type over. */
export function openFind(): void {
  useGraph.getState().openFind();
  requestAnimationFrame(() =>
    document.querySelector<HTMLInputElement>('input[aria-label="Find in the graph"]')?.select(),
  );
}

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
    case 's':
      graph.setFilter('symbols', !graph.filters.symbols);
      return true;
    case 'd':
      graph.setFilter('consumers', !graph.filters.consumers);
      return true;
    case 'T':
      graph.setFilter('tests', !graph.filters.tests);
      return true;
    case '/':
      openFind();
      return true;
    case 'n':
    case 'N':
      if (graph.find == null) return false;
      graph.stepFind(e.key === 'n' ? 1 : -1);
      return true;
    case 'z':
      // `zz` does what a double-click does: frames the selection with its links, else fits the graph.
      if (e.repeat) return true;
      if (e.timeStamp - zAt > CHORD_MS) {
        zAt = e.timeStamp;
        return true;
      }
      zAt = -Infinity;
      if (graph.selected) canvasControl.frame(graph.selected);
      else canvasControl.fit();
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
