import { ChevronDown, ChevronRight, GitCommitHorizontal } from 'lucide-react';
import { useState } from 'react';
import { twMerge } from 'tailwind-merge';
import type { RangeCommit, RangeCommits } from '../../shared/protocol.js';
import { commitBody } from '../model.js';
import { useStore } from '../store.js';
import { Button } from '../ui/Button.js';

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

/** Longer ranges start collapsed so the threads keep the panel. */
const OPEN_UP_TO = 5;

/**
 * The compared range's commits, oldest first, one line each; a row expands to its
 * message and author. A hash opens the compare menu's Commit… pane on that commit.
 */
export function CommitNavigator({ commits }: { commits: RangeCommits }) {
  const [open, setOpen] = useState(commits.total <= OPEN_UP_TO);
  // By sha, so a refresh that adds commits keeps the same rows expanded.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (sha: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(sha)) next.add(sha);
      return next;
    });
  const older = commits.total - commits.list.length;
  return (
    <section
      className="flex max-h-[40%] shrink-0 flex-col border-b border-b-border text-[0.8125rem]"
      aria-label="Commits"
    >
      <Button
        variant="ghost"
        className="min-h-10 flex-none gap-1.5 rounded-none px-2.5 py-1.5 text-left font-semibold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <GitCommitHorizontal size="0.9375rem" className="flex-none" /> Commits
        <span className="rounded-[0.625rem] bg-hover px-1.75 py-0 font-medium text-muted">{commits.total}</span>
        {open ? (
          <ChevronDown size="0.875rem" className="ml-auto flex-none text-muted" />
        ) : (
          <ChevronRight size="0.875rem" className="ml-auto flex-none text-muted" />
        )}
      </Button>
      {open && (
        <div className="min-h-0 overflow-auto pb-1.5">
          {older > 0 && (
            <p className="m-0 px-2.5 py-1 text-[0.75rem] text-muted">
              {older} older {older === 1 ? 'commit' : 'commits'} not shown
            </p>
          )}
          <ol className="m-0 list-none p-0">
            {commits.list.map((commit) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                rail={commits.list.length > 1}
                expanded={expanded.has(commit.sha)}
                onToggle={() => toggle(commit.sha)}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function CommitRow({
  commit,
  rail,
  expanded,
  onToggle,
}: {
  commit: RangeCommit;
  rail: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const openCommitPane = useStore((s) => s.openCommitPane);
  const subject = commit.message.split('\n', 1)[0] || '(Empty commit message)';
  const body = commitBody(commit.message);
  return (
    <li className="group relative hover:bg-hover">
      {rail && (
        // The rail between the dots: it starts at the first dot and stops at the last.
        <span
          aria-hidden
          className="absolute top-0 bottom-0 left-[0.8125rem] w-px bg-border group-first:top-[0.8125rem] group-last:bottom-auto group-last:h-[0.8125rem]"
        />
      )}
      <div className="flex items-start gap-1 pr-1.5 pl-2.5">
        <Button
          variant="ghost"
          className="min-w-0 flex-1 items-start gap-2 rounded-none p-0 py-1 text-left leading-[1.125rem] hover:bg-transparent"
          aria-expanded={expanded}
          title={expanded ? undefined : subject}
          onClick={onToggle}
        >
          <span
            aria-hidden
            className={twMerge(
              // The first line's middle, where the rail meets it.
              'relative mt-1.25 size-2 flex-none rounded-full border-[1.5px]',
              expanded ? 'border-accent bg-accent' : 'border-muted bg-surface group-hover:bg-hover',
            )}
          />
          <span className={expanded ? 'min-w-0 wrap-anywhere' : 'min-w-0 truncate'}>{subject}</span>
        </Button>
        <Button
          variant="ghost"
          className="mt-1 flex-none px-1 py-px font-mono text-[0.75rem] text-muted hover:text-foreground"
          title="Pick this commit in the compare menu"
          aria-label={`Pick commit ${commit.short} in the compare menu`}
          onClick={() => openCommitPane(commit.short)}
        >
          {commit.short}
        </Button>
      </div>
      {expanded && (
        <div className="pr-2.5 pb-1.5 pl-6.5 leading-[1.4]">
          {body.map((paragraph, i) => (
            <p key={i} className="m-0 mb-1.5 wrap-anywhere whitespace-pre-wrap text-muted">
              {paragraph}
            </p>
          ))}
          <p className="m-0 flex min-w-0 items-center gap-1.5 text-[0.75rem] text-muted">
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
          </p>
        </div>
      )}
    </li>
  );
}
