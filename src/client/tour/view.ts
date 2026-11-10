import { Route } from 'lucide-react';
import { canvasKeys } from '@/client/canvas/keys.js';
import type { ViewDef } from '@/client/views/state.js';
import { TOUR_HELP } from './help.js';
import { tourPlace, useTour } from './state.js';
import { StepOutline } from './StepOutline.js';
import { tourCanvas } from './TourCanvas.js';
import { TourView } from './TourView.js';

/** Keys the tour leaves to the review: help, theme, the mode picker, the graph and `T` back to the diff. */
const TOUR_PASSES = new Set(['?', 't', 'm', 'M', 'T', 'o']);

/** The agent's guided tour of the change, which exists once an agent pushed one (`diffle tour push`). */
export const tourView: ViewDef = {
  id: 'tour',
  label: 'Tour',
  icon: Route,
  title: "The agent's guided tour of the change (T)",
  Main: TourView,
  Side: StepOutline,
  help: TOUR_HELP,
  panelLabel: 'steps panel',
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
      default:
        return canvasKeys(e, tourCanvas);
    }
  },
  passes: TOUR_PASSES,
};
