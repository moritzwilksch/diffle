import { MessageSquarePlus } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { api } from '@/client/api.js';
import { FilePath } from '@/client/FilePath.js';
import { Markdown } from '@/client/Markdown.js';
import { Pictures } from '@/client/review/ImageDiff.js';
import { Button } from '@/client/ui/Button.js';
import type { ReportAnchor, ReportBlock, ReportPage } from '@/shared/protocol.js';
import { useReports } from './state.js';

/** `path:line`, or `path:start-end`, as comments name their place. */
export function anchorLabel(a: ReportAnchor): string {
  const lines = a.endLine != null && a.endLine !== a.line ? `${a.line}-${a.endLine}` : `${a.line}`;
  return `${a.path}:${lines}${a.side === 'old' ? ' (removed)' : ''}`;
}

/** One block of the shown report. The cursor's block is outlined; its anchor is where `c` comments. */
export function Block({ id, block, index }: { id: string; block: ReportBlock; index: number }) {
  const atCursor = useReports((s) => s.cursor === index);
  const setCursor = useReports((s) => s.setCursor);
  return (
    <article
      data-report-block={index}
      aria-current={atCursor ? 'true' : undefined}
      onClick={() => setCursor(index)}
      className={twMerge(
        'rounded-md border border-border bg-card shadow-card [transition:border-color_120ms_ease]',
        atCursor && 'border-accent',
      )}
    >
      {block.kind === 'markdown' ? (
        <>
          {block.anchor && <AnchorBar anchor={block.anchor} />}
          <div className="px-4 py-3 text-[0.875rem] leading-[1.5]">
            <Markdown text={block.text} />
          </div>
        </>
      ) : (
        <>
          {block.label && (
            <div className="border-b border-b-border bg-hover px-3 py-1 text-[0.75rem] font-semibold text-muted">
              {block.label}
            </div>
          )}
          <div className="flex flex-col gap-4 px-4 py-3 font-sans text-[0.8125rem]">
            {block.pages.map((page, i) => (
              <Page key={i} id={id} page={page} />
            ))}
          </div>
        </>
      )}
    </article>
  );
}

/** Where a block points: a click opens the diff there, the button comments there. */
function AnchorBar({ anchor }: { anchor: ReportAnchor }) {
  const jump = useReports((s) => s.jump);
  const comment = useReports((s) => s.comment);
  return (
    <div className="flex items-center gap-2 border-b border-b-border bg-hover py-1 pr-1.5 pl-3 text-[0.75rem] text-muted">
      <button
        type="button"
        className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 font-mono text-foreground hover:underline"
        onClick={(e) => {
          e.stopPropagation();
          void jump(anchor);
        }}
        title="Open this line in the diff (Enter)"
      >
        <FilePath path={anchor.path} />:{anchorLabel(anchor).split(':').slice(1).join(':')}
      </button>
      <Button
        variant="ghost"
        className="ml-auto gap-1 px-1.5 py-px text-[0.75rem] leading-[1.2]"
        onClick={(e) => {
          e.stopPropagation();
          void comment(anchor);
        }}
        title="Comment on this line in the diff (c)"
      >
        <MessageSquarePlus size="0.75rem" /> Comment
      </Button>
    </div>
  );
}

function Page({ id, page }: { id: string; page: ReportPage }) {
  const url = {
    old: page.old ? api.reportFileUrl(id, page.old.key) : null,
    new: page.new ? api.reportFileUrl(id, page.new.key) : null,
  };
  const sides = page.old && page.new ? 'both' : page.old ? 'old' : 'new';
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex items-center gap-2 font-semibold">
        {page.label}
        {page.anchor && <PageAnchor anchor={page.anchor} />}
      </figcaption>
      <Pictures path={page.label} sides={sides} url={url} />
    </figure>
  );
}

function PageAnchor({ anchor }: { anchor: ReportAnchor }) {
  const jump = useReports((s) => s.jump);
  return (
    <button
      type="button"
      className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.75rem] font-normal text-muted hover:underline"
      onClick={() => void jump(anchor)}
      title="Open this line in the diff"
    >
      {anchorLabel(anchor)}
    </button>
  );
}
