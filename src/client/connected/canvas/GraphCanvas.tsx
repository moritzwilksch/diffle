import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from 'react';
import { GraphEdgeLabel, GraphEdgeLine, type GraphEdgeProps } from './GraphEdge.js';
import { GraphControls, GraphLegend } from './GraphLegend.js';
import { GraphNode } from './GraphNode.js';
import type { GraphLayout, RoutedEdge } from '@/client/connected/graph/layout.js';
import { firstNode, neighbour } from '@/client/connected/graph/nav.js';
import {
  KEYS_HELP,
  NODE_STAGGER_CAP,
  graphSummary,
  hasEntrance,
  hiddenNote,
  highlight,
  isLit,
  labelKey,
  labelOffsets,
  lineKey,
  keyAction,
  staggerVar,
  toggleSelection,
  type Selection,
} from '@/client/connected/graph/view.js';
import { ZOOM_STEP, fitTransform, panIntoView, wheelFactor, zoomAt } from '@/client/connected/graph/viewport.js';
import type { Size, Transform } from '@/client/connected/graph/viewport.js';
import './graph.css';

export type { Selection } from '@/client/connected/graph/view.js';

export interface GraphCanvasHandle {
  /** Puts keyboard focus on the active node. */
  focus(): void;
}

export interface GraphCanvasProps {
  layout: GraphLayout;
  /** Controlled: the parent can select an arrow or a file too. */
  selected: Selection;
  onSelect(sel: Selection): void;
  /** Enter or double-click on a file: its path. */
  onOpen(path: string): void;
  /** Changed files left out of `layout` by the node cap. */
  hiddenFiles: number;
  /** Links left out of `layout`. */
  hiddenLinks: number;
  ref?: Ref<GraphCanvasHandle>;
}

interface View {
  t: Transform;
  /** Ease to `t`; off while a drag or the wheel drives it. */
  smooth: boolean;
}

interface Drag {
  pointer: number;
  x: number;
  y: number;
  origin: Transform;
  moved: boolean;
}

/** Pixels the pointer may wander before a press stops being a click. */
const DRAG_SLOP = 3;
const KEEP_VISIBLE_PAD = 32;
const nodeSelector = (id: string): string => `[data-node-id="${CSS.escape(id)}"]`;

/**
 * Draws a cluster's layout as SVG: files as cards, references as arrows from user to used. Pan by dragging,
 * zoom by wheel or buttons, fit on mount and when the layout changes. Roving tabindex: one file is tabbable.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  const { layout, selected, hiddenFiles, hiddenLinks } = props;
  const keysId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ t: { x: 0, y: 0, k: 1 }, smooth: false });
  const [hover, setHover] = useState<Selection>(null);
  const [keyboardFocus, setKeyboardFocus] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(() => firstNode(layout));

  const activeId = active !== null && layout.nodes.some((n) => n.id === active) ? active : firstNode(layout);
  // The latest props and state for stable callbacks, so memoised nodes and arrows skip re-rendering on every pan.
  const latest = useRef({ layout, activeId, size, props });
  latest.current = { layout, activeId, size, props };
  const drag = useRef<Drag | null>(null);
  const userMoved = useRef(false);
  const fittedLayout = useRef<GraphLayout | null>(null);

  const fit = useCallback((smooth: boolean) => {
    const { layout: l, size: s } = latest.current;
    if (!s) return;
    userMoved.current = false;
    setView({ t: fitTransform(l, s), smooth });
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () =>
      setSize((s) =>
        s?.width === el.clientWidth && s.height === el.clientHeight
          ? s
          : { width: el.clientWidth, height: el.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new layout always refits (easing, once there was a first one); a resize refits unless the user moved the view.
  useLayoutEffect(() => {
    if (!size) return;
    const first = fittedLayout.current === null;
    const changed = fittedLayout.current !== layout;
    if (changed || !userMoved.current) fit(changed && !first);
    fittedLayout.current = layout;
  }, [layout, size, fit]);

  // React's wheel listener is passive, so it could not stop the page from scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const point = { x: e.clientX - box.left, y: e.clientY - box.top };
      userMoved.current = true;
      setView((v) => ({ t: zoomAt(v.t, wheelFactor(e.deltaY, e.deltaMode), point), smooth: false }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const { size: s } = latest.current;
    if (!s) return;
    userMoved.current = true;
    setView((v) => ({ t: zoomAt(v.t, factor, { x: s.width / 2, y: s.height / 2 }), smooth: true }));
  }, []);

  const focusNode = useCallback((id: string | null) => {
    if (id !== null) rootRef.current?.querySelector<SVGGElement>(nodeSelector(id))?.focus({ preventScroll: true });
  }, []);
  useImperativeHandle(props.ref, () => ({ focus: () => focusNode(latest.current.activeId) }), [focusNode]);

  const selectNode = useCallback((id: string) => latest.current.props.onSelect({ kind: 'node', id }), []);
  const selectEdge = useCallback((id: string) => latest.current.props.onSelect({ kind: 'edge', id }), []);
  const openNode = useCallback((id: string) => latest.current.props.onOpen(id), []);
  const hoverNode = useCallback((id: string | null) => setHover(id === null ? null : { kind: 'node', id }), []);
  const hoverEdge = useCallback((id: string | null) => setHover(id === null ? null : { kind: 'edge', id }), []);
  const onFocusNode = useCallback((id: string, keyboard: boolean) => {
    setActive(id);
    setKeyboardFocus(keyboard ? id : null);
  }, []);
  const onBlurNode = useCallback((id: string) => setKeyboardFocus((k) => (k === id ? null : k)), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const id = (e.target as Element).closest('[data-node-id]')?.getAttribute('data-node-id');
    const action = keyAction(e.key);
    if (!id || !action || e.ctrlKey || e.metaKey || e.altKey) return;
    // The app keymap listens on window: a handled key must not reach it.
    e.preventDefault();
    e.stopPropagation();
    switch (action.type) {
      case 'step': {
        const next = neighbour(layout, id, action.dir);
        const to = next === null ? undefined : layout.nodes.find((n) => n.id === next);
        if (!to) return;
        setActive(to.id);
        focusNode(to.id);
        userMoved.current = true;
        if (size)
          setView((v) => ({
            t: panIntoView(v.t, { x: to.x - to.w / 2, y: to.y - to.h / 2, w: to.w, h: to.h }, size, KEEP_VISIBLE_PAD),
            smooth: true,
          }));
        return;
      }
      case 'open':
        props.onOpen(id);
        return;
      case 'select':
        props.onSelect(toggleSelection(selected, { kind: 'node', id }));
        return;
      case 'zoom':
        zoomBy(action.factor);
        return;
      case 'fit':
        fit(true);
        return;
    }
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-graph-item]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, origin: view.t, moved: false };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      userMoved.current = true;
    }
    // Browsers coalesce pointermove to one per frame: a single state write is all a drag costs.
    setView({ t: { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy }, smooth: false });
  };
  const onPointerEnd = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    // Keep `moved` until the click that follows a drag has been swallowed.
    if (!drag.current.moved) drag.current = null;
  };
  const onBackgroundClick = () => {
    if (drag.current?.moved) {
      drag.current = null;
      return;
    }
    drag.current = null;
    props.onSelect(null);
    focusNode(activeId);
  };

  const order = useMemo(() => {
    const ranked = [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
    return new Map(ranked.map((n, i) => [n.id, i]));
  }, [layout]);
  // Primitives as dependencies: callers rebuild the selection objects.
  const [hk, hi, sk, si] = [hover?.kind, hover?.id, selected?.kind, selected?.id];
  const current = useMemo<Selection>(() => {
    // A selection stays as it is; hover and focus only preview while nothing is selected.
    if (sk && si !== undefined) return { kind: sk, id: si };
    if (hk && hi !== undefined) return { kind: hk, id: hi };
    return keyboardFocus !== null ? { kind: 'node', id: keyboardFocus } : null;
  }, [hk, hi, keyboardFocus, sk, si]);
  const lit = useMemo(() => highlight(layout, current), [layout, current]);
  const nudges = useMemo(() => labelOffsets(layout.edges), [layout]);

  const edgeProps = (edge: RoutedEdge): GraphEdgeProps => ({
    edge,
    order: order.get(edge.from) ?? 0,
    selected: selected?.kind === 'edge' && selected.id === edge.id,
    lit: isLit(lit, 'edge', edge.id),
    nudge: nudges.get(edge.id),
    onSelect: selectEdge,
    onHover: hoverEdge,
  });
  const rootStyle = staggerVar('--n', layout.nodes.length, NODE_STAGGER_CAP);
  const { t } = view;
  const note = hiddenNote(hiddenFiles, hiddenLinks);
  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={graphSummary(layout.nodes.length, layout.edges.length, hiddenFiles, hiddenLinks)}
      aria-describedby={keysId}
      className="relative size-full overflow-hidden bg-surface"
      style={rootStyle}
      data-entrance={hasEntrance(layout.nodes.length)}
      onKeyDown={onKeyDown}
    >
      <p id={keysId} className="sr-only">
        {KEYS_HELP}
      </p>
      <svg
        ref={svgRef}
        className="block size-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onBackgroundClick}
        onDoubleClick={() => fit(true)}
      >
        <g
          data-motion="content"
          data-smooth={view.smooth}
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }}
        >
          {layout.edges.map((e) => (
            <GraphEdgeLine key={lineKey(e)} {...edgeProps(e)} />
          ))}
          {layout.nodes.map((n) => (
            <GraphNode
              key={n.id}
              node={n}
              order={order.get(n.id) ?? 0}
              tabbable={n.id === activeId}
              selected={selected?.kind === 'node' && selected.id === n.id}
              lit={isLit(lit, 'node', n.id)}
              onSelect={selectNode}
              onOpen={openNode}
              onHover={hoverNode}
              onFocusNode={onFocusNode}
              onBlurNode={onBlurNode}
            />
          ))}
          {layout.edges.map((e) => (
            <GraphEdgeLabel key={labelKey(e)} {...edgeProps(e)} />
          ))}
        </g>
      </svg>
      {note && <p className="pointer-events-none absolute top-3 left-3 m-0 text-[12px] text-muted">{note}</p>}
      <GraphLegend />
      <GraphControls
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onFit={() => fit(true)}
      />
    </div>
  );
}
