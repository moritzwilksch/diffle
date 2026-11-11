import { MessageSquare } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { CommentPanel } from '@/client/comments/CommentPanel.js';
import { useTourThreads } from './comments.js';
import { useTour } from './state.js';

const ENTRY =
  'flex w-full cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 text-left text-foreground hover:bg-hover';

/**
 * The tour's side panel: its contents as tall as they need, up to a share of the height, over the
 * diff view's comment panel, which lists every thread, the code's and the tour's. Each scrolls alone.
 */
export function TourSide() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="max-h-[45%] shrink-0 overflow-auto border-b border-b-border">
        <TourContents />
      </div>
      <div className="flex min-h-0 flex-1 flex-col [&>aside]:flex-1">
        <CommentPanel />
      </div>
    </div>
  );
}

/**
 * The table of contents, each `h2` a step of the walk with its `h3`s under
 * it. It marks the section read, those holding a diff whose lines left the review, and how many
 * comments each holds.
 */
export function TourContents() {
  const load = useTour((s) => s.load);
  const step = useTour((s) => s.step);
  const stale = useTour((s) => s.stale);
  const { live } = useTourThreads();
  if (load.state !== 'ready') return null;
  const comments = (index: number) => live.filter((t) => t.anchor.step === index + 1).length;
  const { title, sections } = load.doc;
  return (
    <nav className="flex flex-col bg-surface p-3" aria-label="Contents">
      <h2 className="m-0 mb-2 px-2 text-[0.8125rem] font-semibold">{title ?? 'Contents'}</h2>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sections.map((section) => (
          <li key={section.index}>
            <button
              type="button"
              aria-current={section.index === step ? 'step' : undefined}
              className={twMerge(
                ENTRY,
                'py-1.5 text-[0.8125rem]',
                section.index === step && 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] font-medium',
              )}
              onClick={() => useTour.getState().goTo(section.index)}
            >
              <span className="w-4 shrink-0 text-right text-muted tabular-nums">{section.index + 1}</span>
              <span className="min-w-0 flex-1 leading-5">{section.title}</span>
              {comments(section.index) > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[0.6875rem] leading-5 text-muted">
                  <MessageSquare size="0.6875rem" aria-label="comments" />
                  {comments(section.index)}
                </span>
              )}
              {stale.has(section.index) && (
                <span className="shrink-0 text-[0.6875rem] leading-5 text-warn" title="A diff in it left the review">
                  stale
                </span>
              )}
            </button>
            {section.subsections.length > 0 && (
              <ol className="m-0 list-none p-0 pl-6">
                {section.subsections.map((sub) => (
                  <li key={sub.index}>
                    <button
                      type="button"
                      className={twMerge(ENTRY, 'py-1 text-[0.75rem] text-muted')}
                      onClick={() => useTour.getState().goTo(section.index, sub.index)}
                    >
                      {sub.title}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
