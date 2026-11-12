import { createElement, Fragment, type ReactNode } from 'react';
import { TourTagSchema } from '@/shared/tour.js';
import { placeOf } from './anchor.js';
import { lineSpan, primitive } from './document.js';
import { type CheckProps, type SymbolProps, useHost } from './host/host.js';
import { Callout } from './primitives/Callout.js';
import { TourCard } from './primitives/Card.js';
import { TourCode } from './primitives/Code.js';
import { TourDiff } from './primitives/Diff.js';
import { TourIcon } from './primitives/Icon.js';
import { TourJump } from './primitives/Jump.js';
import { TourTabs } from './primitives/Tabs.js';
import { TourTree } from './primitives/Tree.js';
import { TourDiagram } from './steps/StepDiagram.js';
import { TourTrace } from './steps/Trace.js';
import { TourWalk } from './steps/Walk.js';

/**
 * An article or what a block in it holds, as React: the plain tags `TourTag` allows (an `a` only to
 * an http(s) URL, a table cell with its spans), the content primitives, and text. Everything else,
 * its attributes included, is left out, so a tour, written by an agent that read untrusted code,
 * can do no more than the catalog says.
 */
export function TourContent({ of }: { of: Element }): ReactNode {
  return [...of.childNodes].map((node, i) => contentNode(node, i));
}

/**
 * The article itself: as `TourContent`, with each `h2` carrying its step number in `data-step`, and
 * what `after` gives for each top-level element, by its place, after it.
 */
export function TourArticle({ of, after }: { of: Element; after?: (index: number) => ReactNode }): ReactNode {
  let step = 0;
  return [...of.children].map((node, i) => (
    <Fragment key={i}>
      {node.localName === 'h2'
        ? createElement('h2', { 'data-step': ++step, ...placeOf(node) }, <TourContent of={node} />)
        : contentNode(node, i)}
      {after?.(i)}
    </Fragment>
  ));
}

function contentNode(node: ChildNode, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof Element)) return null;
  const tag = TourTagSchema.safeParse(node.localName);
  if (tag.success) {
    const href = node.getAttribute('href');
    const link =
      tag.data === 'a' && href && /^https?:\/\//.test(href) ? { href, target: '_blank', rel: 'noreferrer' } : {};
    const spans =
      tag.data === 'th' || tag.data === 'td' ? { colSpan: span(node, 'colspan'), rowSpan: span(node, 'rowspan') } : {};
    return createElement(tag.data, { key, ...link, ...spans, ...placeOf(node) }, <TourContent of={node} />);
  }
  const element = primitive(node);
  switch (element?.tag) {
    case 'diffle-diff': {
      const [start, end] = lineSpan(element.lines);
      return (
        <TourDiff
          key={key}
          range={{
            path: element.path,
            side: element.side ?? 'new',
            start,
            end,
          }}
          place={placeOf(node)}
        />
      );
    }
    case 'diffle-walk': {
      const [start, end] = lineSpan(element.lines);
      const range = { path: element.path, side: element.side ?? 'new', start, end };
      return <TourWalk key={key} source={node} range={range} renderNote={noteContent} />;
    }
    case 'diffle-trace':
      return <TourTrace key={key} source={node} renderNote={noteContent} />;
    case 'diffle-check':
      return <TourCheck key={key} source={node} renderItem={noteContent} />;
    case 'diffle-tabs':
      return <TourTabs key={key} source={node} renderPane={paneContent} />;
    case 'diffle-tree':
      return (
        <TourTree
          key={key}
          paths={element.paths}
          root={element.root ?? ''}
          title={element.title}
          icon={element.icon}
          notes={treeNotes(node)}
          place={placeOf(node)}
        />
      );
    case 'diffle-jump': {
      const line = element.line == null ? undefined : Number(element.line);
      const label = node.textContent?.trim() || (line == null ? element.path : `${element.path}:${line}`);
      return <TourJump key={key} path={element.path} line={line} side={element.side ?? 'new'} label={label} />;
    }
    case 'diffle-symbol':
      return (
        <TourSymbol
          key={key}
          path={element.path}
          line={Number(element.line)}
          name={element.name}
          side={element.side ?? 'new'}
        />
      );
    case 'diffle-diagram':
      return <TourDiagram key={key} of={node} renderNote={noteContent} />;
    case 'diffle-code':
      return (
        <TourCode
          key={key}
          place={placeOf(node)}
          code={node.textContent ?? ''}
          lang={element.lang}
          path={element.path}
          line={element.line == null ? undefined : Number(element.line)}
          example={element.example != null}
          title={element.title}
        />
      );
    case 'diffle-row':
      return (
        <div key={key} className="tour-row" data-columns={node.children.length} {...placeOf(node)}>
          {[...node.children].map((column, i) => contentNode(column, i))}
        </div>
      );
    case 'diffle-card':
      return (
        <TourCard key={key} id={element.id} title={element.title} icon={element.icon} place={placeOf(node)}>
          <TourContent of={node} />
        </TourCard>
      );
    case 'diffle-icon':
      return <TourIcon key={key} name={element.name} tone={element.tone} />;
    case 'diffle-callout':
      return (
        <Callout key={key} kind={element.kind} place={placeOf(node)}>
          <TourContent of={node} />
        </Callout>
      );
    default:
      return null;
  }
}

/** A `diffle-symbol`, as the host draws one. */
function TourSymbol(props: SymbolProps) {
  const { Symbol } = useHost();
  return <Symbol {...props} />;
}

/** A `diffle-check`, as the host keeps its ticks. */
function TourCheck(props: CheckProps) {
  const { Check } = useHost();
  return <Check {...props} />;
}

/** A walk's note as inline prose; one function, so a walk reads its notes once per document. */
function noteContent(note: Element): ReactNode {
  return <TourContent of={note} />;
}

/** A tab's pane as the article renders a card's content; one function, so tabs read their panes once. */
function paneContent(tab: Element): ReactNode {
  return <TourContent of={tab} />;
}

/** A tree's notes by the path each sits beside, as inline prose. */
function treeNotes(tree: Element): Map<string, ReactNode> {
  return new Map(
    [...tree.children].flatMap((el) => {
      const file = primitive(el);
      return file?.tag === 'diffle-file' ? [[file.path, <TourContent key={file.path} of={el} />] as const] : [];
    }),
  );
}

/** A cell's `colspan` or `rowspan` when it is a positive number. */
function span(cell: Element, name: string): number | undefined {
  const value = cell.getAttribute(name);
  return value && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}
