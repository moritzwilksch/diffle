import { useStore } from '@/client/store.js';
import { cursorAnchor, useReports } from './state.js';

/** Keys the reports leave to the review: help, theme, the menus, `M` to the graph, and `gr` back to the diff. */
export const REPORTS_PASSES = new Set(['?', 't', 'm', 'M', 'o', 'g', 'r']);

/** The reports view's own keys; true when `e` was one. The keymap calls it only while the view shows. */
export function reportsKeys(e: KeyboardEvent): boolean {
  const reports = useReports.getState();
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      reports.moveCursor(1);
      return true;
    case 'k':
    case 'ArrowUp':
      reports.moveCursor(-1);
      return true;
    case 'J':
    case ']':
      reports.step(1);
      return true;
    case 'K':
    case '[':
      reports.step(-1);
      return true;
    case 'c':
    case 'Enter': {
      const anchor = cursorAnchor(reports);
      if (!anchor) {
        useStore.getState().flash('This block points at no line of the diff');
        return true;
      }
      void (e.key === 'c' ? reports.comment(anchor) : reports.jump(anchor));
      return true;
    }
    default:
      return false;
  }
}
