import { useEffect, useState } from 'react';
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

  if (count === null) return <p className="mode-hint">Enter a positive whole number to preview commits.</p>;
  const current = state?.count === count && state.version === version ? state : null;
  if (!current)
    return (
      <p className="mode-hint" role="status">
        Loading commit messages…
      </p>
    );
  if (current.error)
    return (
      <p className="mode-error" role="status">
        {current.error}
      </p>
    );
  const result = current.result!;
  return (
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
  );
}
