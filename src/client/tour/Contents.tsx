import { twMerge } from 'tailwind-merge';
import { useTour } from './state.js';

const ENTRY =
  'flex w-full cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 text-left text-foreground hover:bg-hover';

/**
 * The side panel: the article's table of contents, each `h2` a step of the walk with its `h3`s under
 * it. It marks the section read and those holding a diff whose lines left the review.
 */
export function TourContents() {
  const load = useTour((s) => s.load);
  const step = useTour((s) => s.step);
  const stale = useTour((s) => s.stale);
  if (load.state !== 'ready') return null;
  const { title, sections } = load.doc;
  return (
    <nav className="flex h-full min-h-0 flex-col overflow-auto bg-surface p-3" aria-label="Contents">
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
