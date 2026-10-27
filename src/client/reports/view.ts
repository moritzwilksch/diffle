import { FileText } from 'lucide-react';
import type { ViewDef } from '@/client/views/state.js';
import { REPORTS_HELP } from './help.js';
import { REPORTS_PASSES, reportsKeys } from './keys.js';
import { ReportsPanel } from './ReportsPanel.js';
import { ReportsView } from './ReportsView.js';
import { enterReports, reportsPlace } from './state.js';

/** Reports: what plugins made of the snapshot and what an agent pushed, beside the diff. */
export const reportsView: ViewDef = {
  id: 'reports',
  label: 'Reports',
  icon: FileText,
  title: 'Reports from plugins and agents (gr)',
  Main: ReportsView,
  Side: ReportsPanel,
  help: REPORTS_HELP,
  panelLabel: 'reports list',
  panelWidth: '18rem',
  enter: enterReports,
  place: reportsPlace,
  keys: reportsKeys,
  passes: REPORTS_PASSES,
};
