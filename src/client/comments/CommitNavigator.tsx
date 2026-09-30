import { ChevronLeft, ChevronRight, GitCommitHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { RangeCommits } from '../../shared/protocol.js';
import { useStore } from '../store.js';
import { Button } from '../ui/Button.js';

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

/**
 * The compared range's commits, one at a time from the oldest. Its hash opens the
 * compare menu's Commit… pane on that commit.
 */
export function CommitNavigator({ commits }: { commits: RangeCommits }) {
  const openCommitPane = useStore((s) => s.openCommitPane);
  // By sha, so a refresh that adds commits keeps the one on show.
  const [sha, setSha] = useState<string | null>(null);
  const found = commits.list.findIndex((c) => c.sha === sha);
  const index = found < 0 ? 0 : found;
  const commit = commits.list[index];
  if (!commit) return null;
  const [subject = '', ...rest] = commit.message.split('\n');
  const body = rest.join('\n').trim();
  // Only the newest commits are listed when the range is longer.
  const position = commits.total - commits.list.length + index + 1;
  const step = (by: number) => setSha(commits.list[index + by]?.sha ?? sha);
  return (
    <section
      className="m-2.5 mb-0 flex max-h-[40%] shrink-0 flex-col overflow-hidden rounded-md border border-border bg-card text-[0.8125rem] leading-[1.4] shadow-card"
      aria-label="Commits"
    >
      <div className="flex items-center gap-2 border-b border-b-border bg-hover py-0.5 pr-1 pl-2.5 text-[0.75rem] text-muted">
        <GitCommitHorizontal size="0.8125rem" className="flex-none text-accent" />
        <span className="mr-auto">
          Commit {position} / {commits.total}
        </span>
        {commits.list.length > 1 && (
          <>
            <Button
              variant="ghost"
              icon
              className="px-0.75"
              disabled={index === 0}
              onClick={() => step(-1)}
              title="Previous commit in the range"
              aria-label="Previous commit in the range"
            >
              <ChevronLeft size="0.875rem" />
            </Button>
            <Button
              variant="ghost"
              icon
              className="px-0.75"
              disabled={index === commits.list.length - 1}
              onClick={() => step(1)}
              title="Next commit in the range"
              aria-label="Next commit in the range"
            >
              <ChevronRight size="0.875rem" />
            </Button>
          </>
        )}
      </div>
      <div className="min-h-0 overflow-auto px-2.5 pt-1.5 pb-2">
        <p className="m-0 font-semibold wrap-anywhere">{subject || '(Empty commit message)'}</p>
        {body && <p className="m-0 mt-1 wrap-anywhere whitespace-pre-wrap text-muted">{body}</p>}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 border-t border-t-border px-2.5 py-1 text-[0.75rem] text-muted">
        <span className="min-w-0 truncate" title={`${commit.author} <${commit.email}>`}>
          {commit.author}
        </span>
        <span aria-hidden>·</span>
        <time
          className="flex-none"
          dateTime={new Date(commit.date).toISOString()}
          title={DATE_TIME.format(commit.date)}
        >
          {DATE.format(commit.date)}
        </time>
        <span aria-hidden>·</span>
        <Button
          variant="ghost"
          className="flex-none px-1 py-px font-mono text-[0.75rem] text-foreground"
          title="Pick this commit in the compare menu"
          aria-label={`Pick commit ${commit.short} in the compare menu`}
          onClick={() => openCommitPane(commit.short)}
        >
          {commit.short}
        </Button>
      </div>
    </section>
  );
}
