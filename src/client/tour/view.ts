import { Route } from 'lucide-react';
import type { ViewDef } from '@/client/views/state.js';
import { TOUR_HELP } from './help.js';
import { tourPlace, useTour } from './state.js';
import { TourSide } from './Contents.js';
import { tourPage } from './TourPage.js';
import { commentOnSelection } from './margin/tourThreads.js';
import { TourView } from './TourView.js';

/** How far `j` and `k` scroll, as a share of the page's height. */
const LINE = 0.1;

/**
 * Keys the tour leaves to the review: help, theme, the mode picker, the graph, `T` back to the diff,
 * and `yy` / `Y`, which copy every comment as the prompt.
 */
const TOUR_PASSES = new Set(['?', 't', 'm', 'M', 'T', 'o', 'y', 'Y']);

/** The agent's guided tour of the change, which exists once an agent pushed one (`diffle tour push`). */
export const tourView: ViewDef = {
  id: 'tour',
  label: 'Tour',
  icon: Route,
  title: "The agent's guided tour of the change (T)",
  Main: TourView,
  Side: TourSide,
  help: TOUR_HELP,
  panelLabel: 'contents and comments panel',
  panelWidth: '17.5rem',
  blocked: () =>
    useTour.getState().load.state === 'ready' ? null : 'No tour yet: an agent pushes one with `diffle tour push`',
  // Offered once there is a tour to show; T says how one comes before then.
  useListed: () => useTour((s) => s.load.state === 'ready'),
  place: tourPlace,
  keys(e) {
    switch (e.key) {
      case 'n':
        useTour.getState().move(1);
        return true;
      case 'p':
        useTour.getState().move(-1);
        return true;
      case 'c':
        return commentOnSelection();
      case 'j':
      case 'ArrowDown':
        tourPage.scroll(LINE);
        return true;
      case 'k':
      case 'ArrowUp':
        tourPage.scroll(-LINE);
        return true;
      case 'd':
        tourPage.scroll(0.5);
        return true;
      case 'u':
        tourPage.scroll(-0.5);
        return true;
      default:
        return false;
    }
  },
  passes: TOUR_PASSES,
};
