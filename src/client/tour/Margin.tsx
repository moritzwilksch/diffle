import { MessageSquarePlus } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { elementKind, tourLabel } from '@/client/comments/threads.js';
import { CommentCard } from '@/client/review/CommentCard.js';
import { CommentComposer } from '@/client/review/CommentComposer.js';
import { useStore, type TourDraft } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { anchorTop, selectionTarget } from './anchor.js';
import { commentOnSelection, DRAFT, type TourThread, useActiveCard, useTourDraft, useTourThreads } from './comments.js';
import { sourceAt, sourceLabel } from './blocks.js';
import { placeCards } from './placement.js';
import { useTour } from './state.js';

/** The composer's header: the words or the element the draft is on, read from the tour's `body`. */
function draftLabel(draft: TourDraft, body: Element | null): string {
  const source = body && sourceAt(body, draft.node);
  const target =
    draft.target.on === 'text' ? draft.target : { on: 'element' as const, label: source ? sourceLabel(source) : '' };
  return tourLabel({ kind: 'tour', node: draft.node, section: '', element: source?.localName ?? '', target });
}

/** One card in the margin or inline: a thread, or the draft. */
function Card({ id, thread, draft }: { id: string; thread?: TourThread; draft?: TourDraft }): ReactNode {
  const body = useTour((s) => (s.load.state === 'ready' ? s.load.doc.body : null));
  // Flush with the margin or the column, where the diff indents them from its gutter.
  if (thread) return <CommentCard thread={thread} className="mx-0" />;
  return draft ? <CommentComposer key={id} label={draftLabel(draft, body)} className="mx-0" /> : null;
}

/** A block the pointer is over, which takes a thread as a whole. */
export interface HoveredBlock {
  el: Element;
  node: number[];
  /** Its source tag, which names its kind. */
  tag: string;
}

/**
 * A button to comment on the hovered block as a whole, in `container` (positioned): level with its
 * top at the margin's `edge`, or just under its bottom-right corner (inline), clear of what it holds.
 */
export function BlockComment({
  block,
  container,
  at,
}: {
  block: HoveredBlock | null;
  container: RefObject<HTMLElement | null>;
  at: 'edge' | 'end';
}) {
  const drafting = useTourDraft() != null;
  const box = container.current?.getBoundingClientRect();
  if (!block || drafting || !box || document.getSelection()?.isCollapsed === false) return null;
  const rect = block.el.getBoundingClientRect();
  const kind = elementKind(block.tag);
  const spot =
    at === 'edge'
      ? { top: rect.top - box.top, left: 0 }
      : { top: rect.bottom - box.top + 2, left: rect.right - box.left, transform: 'translateX(-100%)' };
  return (
    <Button
      className="tour-comment-button"
      style={spot}
      onClick={() => useStore.getState().openTourDraft(block.node, { on: 'element' })}
      title={`Comment on this ${kind}`}
    >
      <MessageSquarePlus size="0.875rem" /> Comment
    </Button>
  );
}

/**
 * The margin beside the article: each thread and the draft level with what it is on, in document
 * order, never overlapping (`placeCards`), and a button to comment on the selected words. `layout`
 * changes whenever the article may have moved under them.
 */
export function Margin({
  article,
  layout,
  onHover,
  hovered,
  block,
}: {
  article: HTMLElement | null;
  block: HoveredBlock | null;
  layout: number;
  onHover: (id: string | null) => void;
  hovered: string | null;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const { live } = useTourThreads();
  const draft = useTourDraft();
  const active = useActiveCard(hovered);
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  const [heights, setHeights] = useState(0);

  const items = [
    ...live.map((t) => ({ id: t.id, anchor: t.anchor, thread: t })),
    ...(draft ? [{ id: DRAFT, anchor: draft, thread: undefined }] : []),
  ];
  useLayoutEffect(() => {
    if (!article || !rail.current) return;
    const origin = rail.current.getBoundingClientRect().top;
    const placed = items.flatMap(({ id, anchor }) => {
      const top = anchorTop(article, anchor);
      return top == null
        ? []
        : [
            {
              id,
              want: top - origin,
              height: cards.current.get(id)?.offsetHeight ?? 0,
            },
          ];
    });
    placed.sort((a, b) => a.want - b.want);
    const next = placeCards(placed, active);
    setTops((prev) => (same(prev, next) ? prev : next));
    // `items` follows `live` and `draft`; `layout` and `heights` count what moved without a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article, live, draft, active, layout, heights]);
  // A card that grows (a reply opened, a message edited) moves the cards below it.
  useEffect(() => {
    const observer = new ResizeObserver(() => setHeights((n) => n + 1));
    for (const el of cards.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [items.length, layout]);

  return (
    <div ref={rail} className="tour-margin" aria-label="Comments">
      {items.map(({ id, thread }) => (
        <div
          key={id}
          ref={(el) => void (el ? cards.current.set(id, el) : cards.current.delete(id))}
          className="tour-margin-card"
          style={{
            top: tops.get(id) ?? 0,
            opacity: tops.has(id) ? 1 : 0,
          }}
          data-active={id === active || undefined}
          onPointerEnter={() => onHover(id)}
          onPointerLeave={() => onHover(null)}
        >
          <Card id={id} thread={thread} draft={id === DRAFT ? (draft ?? undefined) : undefined} />
        </div>
      ))}
      <SelectionComment article={article} container={rail} at="edge" />
      <BlockComment block={block} container={rail} at="edge" />
    </div>
  );
}

function same(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([id, top]) => b.get(id) === top);
}

/**
 * A button to comment on the selected words while they can take one, in `container` (positioned):
 * level with their first line, at its `edge` (the margin) or just past their `end` (inline).
 */
export function SelectionComment({
  article,
  container,
  at,
}: {
  article: HTMLElement | null;
  container: RefObject<HTMLElement | null>;
  at: 'edge' | 'end';
}) {
  const [spot, setSpot] = useState<{ top: number; left: number } | null>(null);
  const drafting = useTourDraft() != null;
  useEffect(() => {
    if (!article) return;
    const update = () => {
      const selection = document.getSelection();
      const found = selectionTarget(selection, article);
      const box = container.current?.getBoundingClientRect();
      if (!found || 'refused' in found || !box) return setSpot(null);
      const words = selection!.getRangeAt(0).getBoundingClientRect();
      setSpot({
        top: words.top - box.top,
        left: at === 'edge' ? 0 : words.right - box.left + 4,
      });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [article, container, at]);
  if (!spot || drafting) return null;
  return (
    <Button
      className="tour-comment-button"
      style={spot}
      // Pressing the button would otherwise clear the selection it comments on.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => void commentOnSelection()}
      title="Comment on the selected words (c)"
    >
      <MessageSquarePlus size="0.875rem" /> Comment
    </Button>
  );
}

/** The threads and the draft on the top-level block at `index`, under it, when the margin has no room. */
export function InlineThreads({ index }: { index: number }) {
  const { live } = useTourThreads();
  const draft = useTourDraft();
  const mine = live.filter((t) => t.anchor.node[0] === index);
  const drafted = draft?.node[0] === index;
  if (!mine.length && !drafted) return null;
  return (
    <div className="tour-inline-threads">
      {mine.map((t) => (
        <Card key={t.id} id={t.id} thread={t} />
      ))}
      {drafted && <Card id={DRAFT} draft={draft} />}
    </div>
  );
}

/** Threads whose passage the tour lost, after its last section. */
export function StaleThreads() {
  const { stale } = useTourThreads();
  if (!stale.length) return null;
  return (
    <section className="tour-stale-threads" aria-label="Comments not in this tour">
      <h2>Not in this tour</h2>
      <p>The agent's last push no longer holds what these comments are on.</p>
      {stale.map((t) => (
        <div key={t.id} data-thread={t.id}>
          <CommentCard thread={t} className="mx-0" />
        </div>
      ))}
    </section>
  );
}
