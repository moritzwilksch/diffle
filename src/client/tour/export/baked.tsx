import type { DiffLineAnnotation } from '@pierre/diffs';
import { createElement, type ReactNode, useLayoutEffect, useRef } from 'react';
import { type RowsProps, rowsKey, type TourHost } from '@/client/tour/host/host.js';
import { type BakedTour, excerptKey, symbolKey, tokensKey } from './data.js';
import { BakedCheck, BakedLucide, BakedSymbol } from './parts.js';

/**
 * The tour as it was exported: every block reads what the export kept, and nothing opens a diff,
 * asks a server, or takes a tick.
 */
export function bakedHost(data: BakedTour): TourHost {
  const changed = new Map(data.changed.map((f) => [f.path, f]));
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(data.rowsCss);
  return {
    useExcerpt: (range, context) => {
      const patch = data.excerpts[excerptKey(range, context)];
      return patch == null ? { state: 'gone' } : { state: 'ready', patch };
    },
    Rows: (props) => (
      <BakedRows {...props} markup={data.rows[rowsKey(props.patch, props.lang, props.numbered)]} sheet={sheet} />
    ),
    open: null,
    Symbol: (props) => <BakedSymbol {...props} baked={data.symbols[symbolKey(props)]} />,
    Check: (props) => <BakedCheck {...props} checks={data.checks} />,
    useChanged: () => changed,
    useTokens: (lines, lang) => data.tokens[tokensKey(lines, lang)] ?? null,
    // The bake keeps every icon the tour names that exists, so any other name is unknown.
    useIcon: (name) => {
      const icon = data.icons[name];
      return icon ? (props) => <BakedLucide icon={icon} {...props} /> : null;
    },
    useFocusedChild: () => {},
  };
}

/**
 * Rows the export kept, in a shadow root as the diff renders them, with the block's `css` and its
 * annotations: each a row of its own under its line, its content slotted in from the page.
 */
function BakedRows<A>({
  markup = '',
  sheet,
  css,
  annotations,
  renderAnnotation,
}: RowsProps<A> & { markup?: string; sheet: CSSStyleSheet }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = ref.current!;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `${markup}<style></style>`;
  }, [markup, sheet]);
  useLayoutEffect(() => {
    // The markup ends in the block's own style element.
    ref.current!.shadowRoot!.lastElementChild!.textContent = css ?? '';
  }, [markup, css]);
  useLayoutEffect(() => {
    const root = ref.current!.shadowRoot!;
    const added = (annotations ?? []).flatMap((a) => annotate(root, a));
    return () => {
      for (const el of added) el.remove();
      fit(root);
    };
  }, [markup, annotations]);
  return createElement(
    'diffs-container',
    { ref },
    renderAnnotation &&
      annotations?.map((a, i) => (
        <div key={i} slot={slotName(a)}>
          {renderAnnotation(a)}
        </div>
      )),
  );
}

/** Where an annotation sits: under a line of one side. */
type Spot = Pick<DiffLineAnnotation<undefined>, 'side' | 'lineNumber'>;

/** The slot an annotation's content fills, named as the diff names it. */
function slotName({ side, lineNumber }: Spot): string {
  return `annotation-${side}-${lineNumber}`;
}

/**
 * Adds a row for `annotation` under its line, in the gutter and the code, as the diff lays one
 * out; returns what it added.
 */
function annotate(root: ShadowRoot, annotation: Spot): Element[] {
  const { side, lineNumber } = annotation;
  const type = side === 'deletions' ? '[data-line-type="change-deletion"]' : ':not([data-line-type="change-deletion"])';
  const line = root.querySelector(`[data-content] > [data-line="${lineNumber}"]${type}`);
  const number = root.querySelector(`[data-gutter] > [data-column-number="${lineNumber}"]${type}`);
  if (!line || !number) return [];
  const row = document.createElement('div');
  row.setAttribute('data-line-annotation', '');
  row.innerHTML = `<div data-annotation-content=""><slot name="${slotName(annotation)}"></slot></div>`;
  const buffer = document.createElement('div');
  buffer.setAttribute('data-gutter-buffer', 'annotation');
  buffer.style.gridRow = 'span 1';
  line.after(row);
  number.after(buffer);
  fit(root);
  return [row, buffer];
}

/** Spans the gutter and the code over as many rows as each holds, annotations included. */
function fit(root: ShadowRoot): void {
  for (const column of root.querySelectorAll<HTMLElement>('[data-gutter], [data-content]')) {
    column.style.gridRow = `span ${column.childElementCount}`;
  }
}
