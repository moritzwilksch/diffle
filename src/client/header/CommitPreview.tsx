import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LastCommitsPreview } from '../../shared/protocol.js';
import { api } from '../api.js';

/** Live endpoint messages; obsolete requests cannot replace a newer count's preview. */
export function CommitPreview({ count, version }: { count: number | null; version: number }) {
  const [state, setState] = useState<{
    count: number;
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
    if (count === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.lastCommitsPreview(count, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setState({ count, version, result });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({ count, version, error: error instanceof Error ? error.message : String(error) });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [count, version]);

  const current = state?.count === count && state.version === version ? state : null;
  const loading = count !== null && !current;
  const status =
    count === null
      ? 'Enter a positive whole number to preview commits.'
      : (current?.error ?? (loading ? 'Loading commit messages…' : null));
  const result = current?.result;
  return (
    <div className="commit-preview-area" ref={area} aria-busy={loading}>
      {status !== null ? (
        <p className={current?.error ? 'mode-error' : 'mode-hint'} role="status">
          {status}
        </p>
      ) : result ? (
        <div className="commit-previews" aria-live="polite">
          {(
            [
              [`HEAD~${count}`, result.old, result.head ? 'Not enough history for this count.' : 'No commits yet.'],
              ['HEAD', result.head, 'No commits yet.'],
            ] as const
          ).map(([ref, commit, missing]) => (
            <div className="commit-preview" key={ref}>
              <div className="commit-preview-ref">
                <span>{ref}</span>
                {commit && <span title={commit.sha}>{commit.short}</span>}
              </div>
              <p>{commit ? commit.message || '(Empty commit message)' : missing}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
