import { BookOpenText, ChevronDown, ChevronRight, ExternalLink, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { twMerge } from 'tailwind-merge';
import type { ChangedFile, StoryFile, StoryPart } from '@/shared/protocol.js';
import { FilePath } from '@/client/FilePath.js';
import { viewedState } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { DiffBlock } from './DiffBlock.js';
import { isFoldedByDefault, partProgress, useStory } from './state.js';

/**
 * The review as a story: the summary, then one band per part with its number, title, narrative and
 * files on the left and their diffs on the right. Reading only: a file's header opens it in the diff
 * for comments and line navigation.
 */
export function StoryPane() {
  const snapshot = useStore((s) => s.snapshot);
  const version = snapshot?.version;
  const state = useStory((s) => s.state);
  const refresh = useStory((s) => s.refresh);
  const cursor = useStory((s) => s.cursor);
  const cursorSeq = useStory((s) => s.cursorSeq);
  const ref = useRef<HTMLElement | null>(null);
  // Every snapshot has its own story (or none): ask again as soon as one arrives.
  useEffect(() => {
    if (version != null) void refresh();
  }, [version, refresh]);
  useEffect(() => {
    if (!cursor || !ref.current) return;
    const card = ref.current.querySelector<HTMLElement>(`[data-story-file="${CSS.escape(cursor)}"]`);
    card?.scrollIntoView({ block: 'center' });
  }, [cursor, cursorSeq]);
  const current = state && state.version === version ? state : null;
  const story = current?.story ?? null;
  return (
    <section ref={ref} className="flex h-full min-h-0 flex-col overflow-y-auto bg-canvas" aria-label="Story view">
      <StoryBar />
      {story && (
        <div className="mx-auto w-full max-w-[100rem] px-4 pb-16">
          <p className="max-w-[48rem] px-2 py-6 text-[0.9375rem] leading-[1.6] text-foreground">{story.summary}</p>
          {story.parts.map((part, i) => (
            <Part key={part.id} part={part} index={i} count={story.parts.length} />
          ))}
        </div>
      )}
    </section>
  );
}

/** What the story is up to: a button to write it, its progress, its failure, or its provenance. */
function StoryBar() {
  const version = useStore((s) => s.snapshot?.version);
  const state = useStory((s) => (s.state?.version === version ? s.state : null));
  const loading = useStory((s) => s.loading);
  const generate = useStory((s) => s.generate);
  const busy = loading || state?.status === 'generating';
  const blocked = state?.blocker ?? null;
  return (
    <div className="flex min-h-[2.5rem] flex-wrap items-center gap-2.5 border-b border-border bg-surface px-3 py-1.5 text-[0.8125rem]">
      <BookOpenText size="0.875rem" className="shrink-0 text-muted" />
      {!state ? (
        <span className="text-muted">Loading…</span>
      ) : busy ? (
        <span className="inline-flex items-center gap-1.5 text-muted">
          <LoaderCircle size="0.875rem" className="animate-spin text-accent" /> Writing the story…
        </span>
      ) : state.status === 'failed' ? (
        <span className="text-danger">{state.error}</span>
      ) : state.story && !state.stale ? (
        <span className="text-muted">
          Written by {state.story.model} on {new Date(state.story.createdAt).toLocaleString()}
        </span>
      ) : state.story ? (
        <span className="text-warn">The story below is from an earlier state of the comparison.</span>
      ) : (
        <span className="text-muted">
          {blocked ?? 'A model groups the changed files into parts a reader follows in order and explains each.'}
        </span>
      )}
      <span className="mr-auto" />
      {state && !busy && !blocked && (
        <Button onClick={() => void generate()} title={state.story ? 'Ask the model again (r)' : 'Ask the model (r)'}>
          <RefreshCw size="0.875rem" />
          {state.story ? 'Write again' : 'Write the story'}
        </Button>
      )}
    </div>
  );
}

const DIGITS = (n: number) => String(n).padStart(2, '0');

function Part({ part, index, count }: { part: StoryPart; index: number; count: number }) {
  const snapshot = useStore((s) => s.snapshot);
  const viewed = useStore((s) => s.viewed);
  const config = useStore((s) => s.config);
  const setViewedMany = useStore((s) => s.setViewedMany);
  if (!snapshot) return null;
  const { files, viewed: done } = partProgress(part, snapshot, { viewed, config });
  const all = files.length > 0 && done === files.length;
  return (
    <div
      className="grid grid-cols-1 gap-x-8 gap-y-3 border-t border-border py-6 xl:grid-cols-[18rem_minmax(0,1fr)]"
      data-story-part={part.id}
    >
      <div className="xl:sticky xl:top-3 xl:self-start">
        <h2 className="text-[1.0625rem] leading-[1.3] font-semibold">{part.title}</h2>
        <label className="mt-1.5 inline-flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted">
          <span className="font-mono">
            {DIGITS(index + 1)} / {DIGITS(count)}
          </span>
          <input
            type="checkbox"
            checked={all}
            ref={(el) => {
              if (el) el.indeterminate = !all && done > 0;
            }}
            onChange={(e) =>
              void setViewedMany(
                files.map((f) => f.path),
                e.target.checked,
              )
            }
          />
          Reviewed
        </label>
        <p className="mt-4 text-[0.875rem] leading-[1.55] text-foreground">{part.narrative}</p>
        <ul className="mt-4 flex list-none flex-col gap-0.5 p-0">
          {files.map((f) => (
            <PartFile key={f.path} file={f} />
          ))}
        </ul>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {part.files.map((f) => (
          <FileCard key={f.path} entry={f} />
        ))}
      </div>
    </div>
  );
}

/** A row of the part's file list: the path and its counts; a click brings its card into view. */
function PartFile({ file }: { file: ChangedFile }) {
  const focus = useStory((s) => s.focus);
  const current = useStory((s) => s.cursor === file.path);
  return (
    <li>
      <button
        type="button"
        className={twMerge(
          'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[0.75rem] hover:bg-hover',
          current && 'bg-hover',
        )}
        onClick={() => focus(file.path)}
      >
        <FileText size="0.75rem" className="shrink-0 text-muted" />
        <FilePath path={file.path} nowrap className="flex-1" />
        <span className="flex shrink-0 gap-1.5 font-mono">
          {file.additions > 0 && <span className="text-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-del">−{file.deletions}</span>}
        </span>
      </button>
    </li>
  );
}

/** One file of a part: its header with the story's note and the viewed mark, and its diff unless folded. */
function FileCard({ entry }: { entry: StoryFile }) {
  const { path } = entry;
  const file = useStore((s) => s.snapshot?.changed.find((f) => f.path === path));
  const loaded = useStore((s) => s.loaded[path]);
  const vs = useStore((s) => (file ? viewedState(s, file) : 'unviewed'));
  const setViewed = useStore((s) => s.setViewed);
  const folded = useStory((s) => s.folded[path]);
  const foldedByDefault = useStore((s) => s.collapsed[path] ?? isFoldedByDefault(s, path));
  const isFolded = folded ?? foldedByDefault;
  const toggleFold = useStory((s) => s.toggleFold);
  const focus = useStory((s) => s.focus);
  const open = useStory((s) => s.open);
  const current = useStory((s) => s.cursor === path);
  if (!file) return null;
  return (
    <article
      data-story-file={path}
      className={twMerge(
        'overflow-hidden rounded-lg border border-border bg-surface',
        current && 'border-accent shadow-[0_0_0_1px_var(--accent)]',
      )}
      onClick={() => {
        if (!current) focus(path);
      }}
    >
      <header className="flex items-center gap-2 border-b border-border bg-hover px-2.5 py-1.5 text-[0.75rem]">
        <FileText size="0.875rem" className="shrink-0 text-muted" />
        {file.oldPath && file.oldPath !== path && (
          <>
            <FilePath path={file.oldPath} nowrap tooltip={false} />
            <span className="text-muted">→</span>
          </>
        )}
        <FilePath path={path} nowrap tooltip={false} />
        <span className="flex shrink-0 gap-2 font-mono">
          <span className="text-del">−{file.deletions}</span>
          <span className="text-add">+{file.additions}</span>
        </span>
        <span className="mr-auto" />
        <label
          className="inline-flex cursor-pointer items-center gap-1 font-sans"
          title={vs === 'restale' ? 'You marked this viewed, then its contents changed' : undefined}
        >
          <input type="checkbox" checked={vs === 'viewed'} onChange={(e) => void setViewed(path, e.target.checked)} />
          Viewed
        </label>
        <Button
          variant="ghost"
          icon
          title="Open in the diff, for comments (Enter)"
          onClick={() => {
            focus(path);
            void open();
          }}
        >
          <ExternalLink size="0.875rem" />
        </Button>
        <Button variant="ghost" icon onClick={() => toggleFold(path)} title="Fold / unfold (z)">
          {isFolded ? <ChevronRight size="0.875rem" /> : <ChevronDown size="0.875rem" />}
        </Button>
      </header>
      {entry.note && <p className="px-3 py-2 text-[0.8125rem] leading-[1.5] text-muted">{entry.note}</p>}
      {!isFolded && (
        <div className="codeview text-[0.8125rem]">
          {loaded?.kind === 'diff' && loaded.fileDiff.hunks.length > 0 ? (
            <DiffBlock fileDiff={loaded.fileDiff} />
          ) : (
            <p className="px-3 py-2 text-muted">{placeholder(file, loaded?.kind)}</p>
          )}
        </div>
      )}
    </article>
  );
}

function placeholder(file: ChangedFile, kind: string | undefined): string {
  if (file.binary) return 'Binary file';
  if (kind === 'oversized') return 'Too large to show here: open it in the diff';
  if (kind === 'error') return 'The diff could not be loaded';
  if (kind === 'diff') return file.status === 'R' ? 'No content changes' : 'No changed lines';
  return 'Loading…';
}
