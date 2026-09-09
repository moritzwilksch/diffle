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
    <div className="commit-preview-area" ref={area} aria-busy={loading}>
      {status !== null ? (
        <p className={current?.error ? 'mode-error' : 'mode-hint'} role="status">
          {status}
        </p>
      ) : result ? (
        <div className="commit-previews" aria-live="polite">
          {(
            [
              [`HEAD~${oldOffset}`, result.old],
              [`HEAD~${newOffset}`, result.new],
            ] as const
          ).map(([ref, commit], index) => (
            <div className="commit-preview" key={index}>
              <div className="commit-preview-ref">
                <span>{ref}</span>
                {commit && <span title={commit.sha}>{commit.short}</span>}
              </div>
              <p>{commit ? commit.message || '(Empty commit message)' : 'Commit unavailable at this offset.'}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
