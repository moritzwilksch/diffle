import type { ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import type { TourSection } from './document.js';

const ENTRY =
  'flex w-full cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 text-left text-foreground hover:bg-hover';

/**
 * A tour's table of contents: its title, each `h2` a step of the walk with its `h3`s under it, and
 * the section read marked. Taking an entry calls `onTake` with its section, and its subsection.
 */
export function Outline({
  title,
  sections,
  current,
  onTake,
  marks,
}: {
  title: string | null;
  sections: readonly TourSection[];
  current: number;
  onTake: (section: number, sub?: number) => void;
  /** What a section's entry shows after its title. */
  marks?: (section: number) => ReactNode;
}) {
  return (
    <nav className="flex flex-col bg-surface p-3" aria-label="Contents">
      <h2 className="m-0 mb-2 px-2 text-[0.8125rem] font-semibold">{title ?? 'Contents'}</h2>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sections.map((section) => (
          <li key={section.index}>
            <button
              type="button"
              aria-current={section.index === current ? 'step' : undefined}
              className={twMerge(
                ENTRY,
                'py-1.5 text-[0.8125rem]',
                section.index === current && 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] font-medium',
              )}
              onClick={() => onTake(section.index)}
            >
              <span className="w-4 shrink-0 text-right text-muted tabular-nums">{section.index + 1}</span>
              <span className="min-w-0 flex-1 leading-5">{section.title}</span>
              {marks?.(section.index)}
            </button>
            {section.subsections.length > 0 && (
              <ol className="m-0 list-none p-0 pl-6">
                {section.subsections.map((sub) => (
                  <li key={sub.index}>
                    <button
                      type="button"
                      className={twMerge(ENTRY, 'py-1 text-[0.75rem] text-muted')}
                      onClick={() => onTake(section.index, sub.index)}
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
