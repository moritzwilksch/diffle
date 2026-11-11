import { createElement, type ReactNode } from 'react';
import { TourTagSchema } from '@/shared/protocol.js';
import { lineSpan, primitive } from './document.js';
import { Callout } from './primitives/Callout.js';
import { TourCard } from './primitives/Card.js';
import { TourDiagram } from './primitives/Diagram.js';
import { TourDiff } from './primitives/Diff.js';
import { TourJump } from './primitives/Jump.js';
import { TourSymbol } from './primitives/Symbol.js';
import { TourTree } from './primitives/Tree.js';

/**
 * An article or what a block in it holds, as React: the plain tags `TourTag` allows (an `a` only to an http(s) URL, a
 * table cell with its spans),
 * the content primitives, and text. Everything else, its attributes included, is left out, so a
 * tour, written by an agent that read untrusted code, can do no more than the catalog says.
 */
export function TourContent({ of, inCallout = false }: { of: Element; inCallout?: boolean }): ReactNode {
  return [...of.childNodes].map((node, i) => contentNode(node, i, inCallout));
}

function contentNode(node: ChildNode, key: number, inCallout: boolean): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof Element)) return null;
  const tag = TourTagSchema.safeParse(node.localName);
  if (tag.success) {
    const href = node.getAttribute('href');
    const link =
      tag.data === 'a' && href && /^https?:\/\//.test(href) ? { href, target: '_blank', rel: 'noreferrer' } : {};
    const spans =
      tag.data === 'th' || tag.data === 'td' ? { colSpan: span(node, 'colspan'), rowSpan: span(node, 'rowspan') } : {};
    return createElement(tag.data, { key, ...link, ...spans }, <TourContent of={node} inCallout={inCallout} />);
  }
  const element = primitive(node);
  switch (element?.tag) {
    case 'diffle-diff': {
      const [start, end] = lineSpan(element.lines);
      return <TourDiff key={key} range={{ path: element.path, side: element.side ?? 'new', start, end }} />;
    }
    case 'diffle-tree':
      return <TourTree key={key} paths={element.paths} root={element.root ?? ''} />;
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
      return <TourDiagram key={key} of={node} />;
    case 'diffle-row':
      return (
        <div key={key} className="tour-row" data-columns={node.children.length}>
          {[...node.children].map((column, i) => contentNode(column, i, inCallout))}
        </div>
      );
    case 'diffle-card':
      return (
        <TourCard key={key} id={element.id} title={element.title}>
          <TourContent of={node} inCallout={inCallout} />
        </TourCard>
      );
    case 'diffle-callout':
      return inCallout ? null : (
        <Callout key={key} kind={element.kind}>
          <TourContent of={node} inCallout />
        </Callout>
      );
    default:
      return null;
  }
}

/** A cell's `colspan` or `rowspan` when it is a positive number. */
function span(cell: Element, name: string): number | undefined {
  const value = cell.getAttribute(name);
  return value && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}
