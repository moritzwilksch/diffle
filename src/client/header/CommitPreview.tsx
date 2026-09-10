import { twMerge } from 'tailwind-merge';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LastCommitsPreview } from '../../shared/protocol.js';
import { api } from '../api.js';

/** Live endpoint messages; obsolete requests cannot replace a newer count's preview. */
export function CommitPreview({
  oldOffset,
  newOffset,
  version,
}: {
  oldOffset: number | null;
  newOffset: number | null;
  version: number;
}) {
  const [state, setState] = useState<{
    oldOffset: number;
    newOffset: number;
    version: number;
    result?: LastCommitsPreview;
    error?: string;
  } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const height = useRef(0);

  // Preserve space already used by messages while loading, clearing, or correcting the count.
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    height.current = Math.max(height.current, element.getBoundingClientRect().height);
    element.style.minHeight = `${height.current}px`;
  });

  useEffect(() => {
    if (oldOffset === null || newOffset === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.lastCommitsPreview(oldOffset, newOffset, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setState({ oldOffset, newOffset, version, result });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({ oldOffset, newOffset, version, error: error instanceof Error ? error.message : String(error) });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [oldOffset, newOffset, version]);

  const current =
    state?.oldOffset === oldOffset && state.newOffset === newOffset && state.version === version ? state : null;
  const loading = oldOffset !== null && newOffset !== null && !current;
  const status =
    oldOffset === null || newOffset === null
      ? 'Enter nonnegative whole numbers to preview commits.'
      : (current?.error ?? (loading ? 'Loading commit messages…' : null));
  const result = current?.result;
  return (
    <div className="min-h-22" ref={area} aria-busy={loading}>
      {status !== null ? (
        <p
          className={twMerge(
            current?.error
              ? 'm-0 text-del text-[0.75rem] wrap-anywhere'
              : 'text-[0.75rem] text-muted m-0 p-0 whitespace-normal',
          )}
          role="status"
        >
          {status}
        </p>
      ) : result ? (
        <div className="grid gap-3 mt-1" aria-live="polite">
          {(
            [
              [`HEAD~${oldOffset}`, result.old],
              [`HEAD~${newOffset}`, result.new],
            ] as const
          ).map(([ref, commit], index) => (
            <div key={index}>
              <div className="flex justify-between gap-2 text-muted font-mono text-[0.6875rem] leading-[1.5]">
                <span>{ref}</span>
                {commit && <span title={commit.sha}>{commit.short}</span>}
              </div>
              <p className="mt-0.5 mb-0 font-sans text-[0.75rem] leading-[1.5] whitespace-pre-wrap wrap-anywhere max-h-24 overflow-auto">
                {commit ? commit.message || '(Empty commit message)' : 'Commit unavailable at this offset.'}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
