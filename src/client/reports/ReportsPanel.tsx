import { AlertTriangle, Bot, FileText, LoaderCircle, Wrench } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import type { Report } from '@/shared/protocol.js';
import { shownReport, useReports } from './state.js';

/** Every report, generated ones first: a click shows it in the main pane. */
export function ReportsPanel() {
  const reports = useReports((s) => s.reports);
  const shown = useReports(shownReport);
  const select = useReports((s) => s.select);
  return (
    <aside className="flex min-h-0 flex-col bg-surface" aria-label="Reports list">
      <div className="flex min-h-10 items-center gap-1.5 border-b border-b-border px-2.5 py-1.5">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-semibold">
          <FileText size="0.9375rem" /> Reports
          {reports.length > 0 && (
            <span className="rounded-[0.625rem] bg-hover px-1.75 py-0 font-medium text-muted">{reports.length}</span>
          )}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-auto p-2.5">
        {reports.length === 0 && <p className="m-0 px-3 py-6 text-center text-muted">No reports yet.</p>}
        {reports.map((r) => (
          <Row key={r.id} report={r} shown={r.id === shown?.id} select={select} />
        ))}
      </div>
    </aside>
  );
}

function Row({ report: r, shown, select }: { report: Report; shown: boolean; select: (id: string) => void }) {
  const Source = r.source === 'generator' ? Wrench : Bot;
  return (
    <button
      type="button"
      aria-current={shown ? 'true' : undefined}
      onClick={() => select(r.id)}
      className={twMerge(
        'flex w-full cursor-pointer flex-col gap-0.5 rounded-md border border-border bg-card p-0 px-2.5 py-1.5 text-left font-sans text-[0.8125rem] leading-[1.4] text-foreground shadow-card [transition:border-color_120ms_ease] hover:border-accent',
        shown && 'border-accent',
        r.stale && 'border-dashed',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Source size="0.8125rem" className="flex-none text-accent" />
        <span className="min-w-0 truncate font-semibold">{r.title}</span>
        {r.status === 'running' && <LoaderCircle size="0.75rem" className="ml-auto animate-spin text-accent" />}
        {r.status === 'failed' && <AlertTriangle size="0.75rem" className="ml-auto text-danger" />}
        {r.status === 'ready' && r.stale && <AlertTriangle size="0.75rem" className="ml-auto text-warn" />}
      </span>
      {(r.summary || r.error) && (
        <span className={twMerge('truncate text-[0.75rem] text-muted', r.error && 'text-danger')}>
          {r.error ?? r.summary}
        </span>
      )}
    </button>
  );
}
