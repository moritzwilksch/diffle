import { AlertTriangle, LoaderCircle, ScrollText } from 'lucide-react';
import { relativeTime } from '@/client/model.js';
import { Button, TOGGLE_ON } from '@/client/ui/Button.js';
import type { Report } from '@/shared/protocol.js';
import { Block } from './Blocks.js';
import { shownReport, useReports } from './state.js';

/** The shown report in the diff's place: its header, its log when opened, and its blocks. */
export function ReportsView() {
  const report = useReports(shownReport);
  const loaded = useReports((s) => s.loaded);
  const error = useReports((s) => s.error);
  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Reports view">
      {report ? <Shown report={report} /> : <Empty loaded={loaded} error={error} />}
    </section>
  );
}

function Shown({ report }: { report: Report }) {
  const log = useReports((s) => (s.log?.id === report.id ? s.log.lines : null));
  const toggleLog = useReports((s) => s.toggleLog);
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-1.5 text-[0.8125rem]">
        <span className="min-w-0 truncate font-semibold">{report.title}</span>
        <Status report={report} />
        <span className="ml-auto text-muted" title={new Date(report.updatedAt).toLocaleString()}>
          {relativeTime(report.updatedAt)}
        </span>
        <Button
          variant="ghost"
          className={log ? TOGGLE_ON : ''}
          onClick={() => void toggleLog(report.id)}
          title="What the report’s maker wrote to stderr, and what was dropped"
          aria-pressed={log != null}
        >
          <ScrollText size="0.8125rem" /> Log
        </Button>
      </div>
      {report.error && (
        <p className="m-0 flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[0.8125rem] text-danger">
          <AlertTriangle size="0.8125rem" /> {report.error}
        </p>
      )}
      {log && (
        <pre className="m-0 max-h-48 overflow-auto border-b border-border bg-surface px-3 py-2 font-mono text-[0.75rem] leading-[1.4] text-muted">
          {log.length ? log.join('\n') : 'Nothing was logged.'}
        </pre>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {report.blocks.length === 0 && report.status === 'running' && (
          <p className="m-0 flex items-center gap-2 text-muted">
            <LoaderCircle size="0.875rem" className="animate-spin text-accent" /> Running
          </p>
        )}
        {report.blocks.map((block, i) => (
          <Block key={i} id={report.id} block={block} index={i} />
        ))}
      </div>
    </>
  );
}

/** Running, failed, or stale, as one word with its mark; nothing while a report is simply ready. */
function Status({ report }: { report: Report }) {
  if (report.status === 'running')
    return (
      <span className="flex items-center gap-1 text-muted">
        <LoaderCircle size="0.8125rem" className="animate-spin text-accent" /> running
      </span>
    );
  if (report.status === 'failed') return <span className="text-danger">failed</span>;
  if (report.stale)
    return (
      <span
        className="flex items-center gap-1 text-warn"
        title="The diff moved on since this report was made: it describes an older state"
      >
        <AlertTriangle size="0.75rem" /> stale
      </span>
    );
  return null;
}

function Empty({ loaded, error }: { loaded: boolean; error: string | null }) {
  return (
    <div className="px-6 py-8 text-muted [&>p]:mt-0 [&>p]:mb-2">
      {error ? (
        <p className="text-danger">{error}</p>
      ) : !loaded ? (
        <p>Loading reports…</p>
      ) : (
        <>
          <p>No reports for this diff.</p>
          <p>
            A plugin on PATH writes one when a changed file matches its globs; <code>diffle plugins</code> lists them.
            Anything else can push one: <code>PUT /api/reports/&lt;id&gt;</code> with a title and markdown blocks, or{' '}
            <code>diffle report put &lt;file&gt;</code> from a shell.
          </p>
        </>
      )}
    </div>
  );
}
