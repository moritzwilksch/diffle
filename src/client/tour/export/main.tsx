import { createRoot } from 'react-dom/client';
import { type BakedTour, DATA_ID } from './data.js';
import { ExportPage } from './ExportPage.js';
import './export.css';

/** The script an exported tour runs: it draws the tour the file keeps. */
const data = JSON.parse(document.getElementById(DATA_ID)!.textContent!) as BakedTour;
createRoot(document.getElementById('root')!).render(<ExportPage data={data} />);
