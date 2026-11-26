import type { GithubInlineThread } from './inlineThreads.js';
import { HostedComment } from './HostedComment.js';
import { GithubThreadActions } from './GithubThreadActions.js';
import { githubThreadKey, setInlineExpanded } from '@/client/comments/inlineExpansion.js';
import { collapseFromCardClick, InlineThreadCollapse } from '@/client/comments/InlineThreadCollapse.js';

export function GithubThreadCard({ inline }: { inline: GithubInlineThread }) {
  const { thread, prUrl, path } = inline;
  const collapse = () => setInlineExpanded(githubThreadKey(thread.id), false, !thread.isResolved);
  return (
    <article
      aria-label="GitHub thread in code"
      className="mx-2 my-1 cursor-pointer rounded-md border border-accent bg-card font-sans text-xs"
      onClick={(event) => collapseFromCardClick(event, collapse)}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <strong className="mr-auto">GitHub thread</strong>
        {thread.isResolved && <span className="text-add">Resolved</span>}
        <InlineThreadCollapse label="Collapse GitHub thread" onCollapse={collapse} />
      </div>
      <div className="max-h-64 divide-y divide-border overflow-auto">
        {thread.comments.map((message) => (
          <HostedComment key={message.id} message={message} prUrl={prUrl} path={path} />
        ))}
      </div>
      <GithubThreadActions key={thread.id} prUrl={prUrl} thread={thread} />
    </article>
  );
}
