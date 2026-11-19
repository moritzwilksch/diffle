import { ExternalLink, X } from 'lucide-react';
import { Markdown } from '@/client/Markdown.js';
import { Button } from '@/client/ui/Button.js';
import { closeGithubPeek, type GithubPeek } from './commentPeek.js';
import { GithubPendingDelete } from './GithubPendingDelete.js';

export function githubCommentBody(body: string): string {
  return body.replace(/\n*<!-- diffle-thread:[^>]* -->\s*$/, '');
}

export function GithubPeekCard({ peek }: { peek: GithubPeek }) {
  const { message } = peek;
  return (
    <article
      aria-label="GitHub comment in code"
      className="mx-2 my-1 rounded-md border border-accent bg-card font-sans text-xs"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <strong className="mr-auto">GitHub · {message.author}</strong>
        {message.state === 'PENDING' && <span className="text-muted">Pending</span>}
        {/^https?:\/\//i.test(message.url) && (
          <a
            href={message.url}
            aria-label="Open comment on GitHub"
            className="p-1 text-accent"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size="0.75rem" />
          </a>
        )}
        <GithubPendingDelete prUrl={peek.prUrl} message={message} />
        <Button
          variant="ghost"
          icon
          aria-label="Close GitHub comment in code"
          onClick={() => closeGithubPeek(message.id)}
        >
          <X size="0.75rem" />
        </Button>
      </div>
      <div className="px-2 py-1.5 wrap-anywhere">
        <Markdown text={githubCommentBody(message.body)} path={peek.path} />
      </div>
    </article>
  );
}
