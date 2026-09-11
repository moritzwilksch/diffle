import { GitPullRequest, ExternalLink } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useStore } from '../store.js';
import { Button } from '../ui/Button.js';

/** GitHub metadata loads independently of the diff. */
export function GithubMenu() {
  const open = useStore((s) => s.githubMenuOpen);
  const setOpen = useStore((s) => s.setGithubMenuOpen);
  const github = useStore((s) => s.github);
  const metadata = github.data;
  const repository = metadata?.repository;
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, setOpen]);
  const pr = metadata?.pullRequest;
  return (
    <div
      className="relative"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <Button
        ref={trigger}
        variant="ghost"
        title="GitHub information (o)"
        aria-label="GitHub information"
        aria-expanded={open}
        aria-controls="github-menu"
        onClick={() => setOpen(!open)}
      >
        <GitPullRequest size="1rem" /> GitHub
      </Button>
      {open && (
        <section
          id="github-menu"
          role="dialog"
          aria-label="GitHub information"
          className="absolute top-[calc(100%+0.375rem)] left-0 z-30 w-80 max-w-[85vw] rounded-lg border border-border bg-surface p-3 text-[0.8125rem] shadow-lg"
        >
          <strong>Repository</strong>
          <p className="mt-1 mb-3 wrap-anywhere">
            {repository ? (
              <a
                className="inline-flex items-center gap-1 text-accent hover:underline"
                href={`https://github.com/${repository}`}
                target="_blank"
                rel="noreferrer"
              >
                {repository}
                <ExternalLink size="0.75rem" />
              </a>
            ) : (
              <span className="text-muted">
                {github.status === 'loading' ? 'Loading…' : metadata ? 'No GitHub origin' : 'Unavailable'}
              </span>
            )}
          </p>
          <strong>Pull request</strong>
          <div aria-live="polite" className="mt-1">
            {github.status === 'loading' ? (
              <p className="text-muted">Loading…</p>
            ) : github.status === 'error' ? (
              <p className="text-warn">Lookup failed: {github.error}</p>
            ) : pr ? (
              <>
                <a className="text-accent hover:underline" href={pr.url} target="_blank" rel="noreferrer">
                  #{pr.number} {pr.title}
                </a>
                <p className="mt-1 text-muted">
                  {pr.state === 'OPEN' ? (pr.isDraft ? 'Draft' : 'Open') : pr.state === 'MERGED' ? 'Merged' : 'Closed'}
                </p>
                {pr.repository !== repository && <p className="text-muted">{pr.repository}</p>}
                {metadata?.reason && <p className="mt-2 text-muted">{metadata?.reason}</p>}
              </>
            ) : (
              <p className="text-muted">{metadata?.reason ?? 'No matching pull request'}</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
