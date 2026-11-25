import { ArrowDownToLine, ArrowUpToLine, Maximize2 } from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '@/client/ui/Button.js';
import { commentLists, showCommentOverlay, type CommentList } from './state.js';

export function CommentListControls({
  list,
  scroller,
  expandable,
}: {
  list: CommentList;
  scroller: RefObject<HTMLDivElement | null>;
  expandable?: boolean;
}) {
  const { title, key } = commentLists[list];
  return (
    <>
      <Button
        variant="ghost"
        icon
        aria-label={`Scroll ${title} to top`}
        title={`Scroll ${title} to top`}
        onClick={() => scroller.current?.scrollTo({ top: 0 })}
      >
        <ArrowUpToLine size="0.875rem" />
      </Button>
      <Button
        variant="ghost"
        icon
        aria-label={`Scroll ${title} to bottom`}
        title={`Scroll ${title} to bottom`}
        onClick={() => {
          const element = scroller.current;
          if (element) element.scrollTo({ top: element.scrollHeight });
        }}
      >
        <ArrowDownToLine size="0.875rem" />
      </Button>
      {expandable && (
        <Button
          variant="ghost"
          icon
          aria-label={`Expand ${title}`}
          aria-haspopup="dialog"
          aria-keyshortcuts={`Shift+${key}`}
          title={`Expand ${title} (${key})`}
          onClick={() => showCommentOverlay(list)}
        >
          <Maximize2 size="0.875rem" />
        </Button>
      )}
    </>
  );
}
