import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { arrowHead } from '@/client/canvas/arrows.js';
import { CanvasSurface } from '@/client/canvas/CanvasSurface.js';
import { CanvasToolbar } from '@/client/canvas/CanvasToolbar.js';
import { CLUSTER_HEADER, layout, type Placed, type Size } from '@/client/canvas/layout/layout.js';
import { rank, type Ranked } from '@/client/canvas/layout/rank.js';
import { attrOf, bounds, type CanvasControl, useViewport, zoomCentre } from '@/client/canvas/viewport.js';
import type { TourArrow, TourCard, TourDocument } from './document.js';
import { Card, CARD_W } from './primitives/Card.js';
import { useTour } from './state.js';

/** What the keys do to the mounted tour canvas. */
export const tourCanvas: CanvasControl = { fit: () => {}, zoom: () => {} };

/** A card's size until it is measured. */
const UNMEASURED: Size = { w: CARD_W, h: 160 };
const FIT_ZOOM = 1;
/** A step glides to its card at its natural size, or smaller when it does not fit. */
const STEP_ZOOM = 1;

/**
 * The tour's cards on the canvas, laid out in layers by their arrows, a group's cards side by side
 * in one frame. Each card is measured once it renders, and the layout follows its size.
 */
export function TourCanvas({ doc }: { doc: TourDocument }) {
  const viewport = useViewport();
  const { view, fitBox } = viewport;
  const steps = useTour((s) => s.load.state === 'ready' && s.load.doc.steps);
  const step = useTour((s) => s.step);
  const focus = useTour((s) => s.focus);
  const stale = useTour((s) => s.stale);
  const [sizes, setSizes] = useState<ReadonlyMap<string, Size>>(new Map());
  const placed = useMemo(() => place(doc, sizes), [doc, sizes]);
  const boxOf = useMemo(() => new Map(placed.nodes.map((p) => [p.node.id, p])), [placed]);
  const current = steps ? steps[step]?.id : undefined;

  const observer = useMemo(
    () =>
      new ResizeObserver((entries) =>
        setSizes((prev) => {
          const next = new Map(prev);
          for (const { target } of entries) {
            const el = target as HTMLElement;
            const size = { w: el.offsetWidth, h: el.offsetHeight };
            const was = prev.get(el.dataset.card!);
            if (was?.w !== size.w || was?.h !== size.h) next.set(el.dataset.card!, size);
          }
          return next.size === prev.size && [...next].every(([id, s]) => prev.get(id) === s) ? prev : next;
        }),
      ),
    [],
  );
  useEffect(() => () => observer.disconnect(), [observer]);
  const measure = (el: HTMLElement | null) => el && observer.observe(el);

  const whole = { x: 0, y: 0, w: placed.width, h: placed.height };
  const fit = () => fitBox(whole, FIT_ZOOM);
  // Fit once every card of a newly pushed tour has its size; later growth (a diff loading) leaves the view be.
  const measured = doc.cards.every((c) => sizes.has(c.id));
  const fitted = useRef<TourDocument | null>(null);
  useEffect(() => {
    if (!measured || fitted.current === doc) return;
    fitted.current = doc;
    fitBox({ x: 0, y: 0, w: placed.width, h: placed.height }, FIT_ZOOM);
  }, [measured, doc, placed, fitBox]);
  useEffect(() => {
    const box = focus && boxOf.get(focus.id);
    if (box) fitBox(bounds([box]), STEP_ZOOM);
    // A step glides once, when it is taken, not again as cards resize.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, fitBox]);
  useEffect(() => {
    tourCanvas.fit = fit;
    tourCanvas.zoom = (factor) => zoomCentre(viewport, factor);
  });

  const onClick = (e: MouseEvent) => {
    const press = viewport.press.current;
    if (!press || press.moved || e.detail > 1) return;
    const id = attrOf(press.target, 'data-card');
    const index = steps ? steps.findIndex((c) => c.id === id) : -1;
    if (index >= 0) useTour.getState().goTo(index);
  };

  return (
    <div className="relative h-full w-full">
      <CanvasSurface
        viewport={viewport}
        label="Tour"
        onClick={onClick}
        onDoubleClick={fit}
        svg={<Frames placed={placed} doc={doc} current={current} />}
        html={placed.nodes.map((p) => (
          <Card
            key={p.node.id}
            card={p.node}
            current={p.node.id === current}
            stale={stale.has(p.node.id)}
            at={p}
            measure={measure}
          />
        ))}
      />
      <CanvasToolbar zoom={view.k} onZoom={(factor) => tourCanvas.zoom(factor)} onFit={() => tourCanvas.fit()} />
    </div>
  );
}

/** The groups' frames with their titles, and the arrows with their labels; the current step's arrows lit. */
function Frames({
  placed,
  doc,
  current,
}: {
  placed: Placed<TourCard, TourArrow>;
  doc: TourDocument;
  current?: string;
}) {
  return (
    <>
      {placed.clusters.map((c) => (
        <g key={`${c.cluster}@${c.layer}@${c.x},${c.y}`}>
          <rect
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            rx={10}
            fill="color-mix(in srgb, var(--accent) 4%, transparent)"
            stroke="var(--border)"
            strokeDasharray="5 4"
          />
          <text x={c.x + 10} y={c.y + CLUSTER_HEADER / 2 + 5} fontSize={13} fontWeight={600} fill="var(--fg-2)">
            {doc.groups[Number(c.cluster)]}
          </text>
        </g>
      ))}
      {placed.edges.map((e) => {
        const lit = e.edge.from === current || e.edge.to === current;
        const mid = e.along(0.5);
        return (
          <g key={`${e.edge.from}>${e.edge.to}`}>
            <path
              d={e.d}
              fill="none"
              stroke={lit ? 'var(--accent)' : 'var(--fg-2)'}
              strokeWidth={lit ? 2 : 1.5}
              strokeDasharray={e.back ? '5 4' : undefined}
              markerEnd={arrowHead(lit ? 2 : 1, lit)}
            />
            {e.edge.label && (
              <text
                x={mid.x}
                y={mid.y + 4}
                textAnchor="middle"
                fontSize={12}
                fill={lit ? 'var(--accent)' : 'var(--fg-2)'}
                stroke="var(--bg)"
                strokeWidth={4}
                paintOrder="stroke"
              >
                {e.edge.label}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

/**
 * The cards placed in layers by their arrows, in document order where that leaves a choice. A group
 * ranks as one unit, so its cards share a layer and one frame; an arrow inside a group bows below it.
 */
function place(doc: TourDocument, sizes: ReadonlyMap<string, Size>): Placed<TourCard, TourArrow> {
  const unit = (c: TourCard) => (c.group == null ? `card:${c.id}` : `group:${c.group}`);
  const unitOf = new Map(doc.cards.map((c) => [c.id, unit(c)]));
  const units = [...new Set(unitOf.values())].map((id) => ({ id }));
  const between = doc.arrows
    .map((a) => ({ from: unitOf.get(a.from)!, to: unitOf.get(a.to)! }))
    .filter((a) => a.from !== a.to);
  const ranked = rank({ nodes: units, edges: between });
  const byCard: Ranked = {
    ...ranked,
    layer: new Map(doc.cards.map((c) => [c.id, ranked.layer.get(unit(c))!])),
  };
  // A group's cards are tied to each other, so one without arrows of its own stays in its group's
  // frame instead of on the shelf of unlinked cards; ties are never drawn.
  const ties = doc.groups.flatMap((_, g) => {
    const members = doc.cards.filter((c) => c.group === g);
    return members.slice(1).map((c, i) => ({ from: members[i]!.id, to: c.id, label: null }));
  });
  const placed = layout({ nodes: doc.cards, edges: [...doc.arrows, ...ties] }, byCard, {
    size: (c) => sizes.get(c.id) ?? UNMEASURED,
    cluster: (c) => (c.group == null ? null : String(c.group)),
  });
  const tied = new Set<TourArrow>(ties);
  return { ...placed, edges: placed.edges.filter((e) => !tied.has(e.edge)) };
}
