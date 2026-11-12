import { createElement, type ReactNode } from 'react';
import { TourTagSchema } from '@/shared/tour-catalog.js';
import { lineSpan, primitive } from './document.js';
import { Callout } from './primitives/Callout.js';
import { TourCard } from './primitives/Card.js';
import { TourCode } from './primitives/Code.js';
import { TourDrawing } from './primitives/Diagram.js';
import { TourDiff } from './primitives/Diff.js';
import { TourIcon } from './primitives/Icon.js';
import { TourJump } from './primitives/Jump.js';
import { TourSymbol } from './primitives/Symbol.js';
import { TourTabs } from './primitives/Tabs.js';
import { TourTree } from './primitives/Tree.js';

/**
 * An article or what a block in it holds, as React: the plain tags `TourTag` allows (an `a` only to
 * an http(s) URL, a table cell with its spans), the content primitives, and text. Everything else,
 * its attributes included, is left out, so a tour, written by an agent that read untrusted code,
 * can do no more than the catalog says.
 */
export function TourContent({ of }: { of: Element }): ReactNode {
  return [...of.childNodes].map((node, i) => contentNode(node, i));
}

/** The article itself: as `TourContent`, with each `h2` carrying its step number in `data-step`. */
export function TourArticle({ of }: { of: Element }): ReactNode {
  let step = 0;
  return [...of.children].map((node, i) =>
    node.localName === 'h2'
      ? createElement('h2', { key: i, 'data-step': ++step }, <TourContent of={node} />)
      : contentNode(node, i),
  );
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
    return createElement(tag.data, { key, ...link, ...spans }, <TourContent of={node} />);
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
        />
      );
    }
    case 'diffle-tabs':
      return <TourTabs key={key} source={node} renderPane={partContent} />;
    case 'diffle-tree':
      return (
        <TourTree
          key={key}
          paths={element.paths}
          root={element.root ?? ''}
          title={element.title}
          icon={element.icon}
          notes={treeNotes(node)}
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
      return <TourDrawing key={key} of={node} />;
    case 'diffle-code':
      return (
        <TourCode
          key={key}
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
        <div key={key} className="tour-row" data-columns={node.children.length}>
          {[...node.children].map((column, i) => contentNode(column, i))}
        </div>
      );
    case 'diffle-card':
      return (
        <TourCard key={key} id={element.id} title={element.title} icon={element.icon}>
          <TourContent of={node} />
        </TourCard>
      );
    case 'diffle-icon':
      return <TourIcon key={key} name={element.name} tone={element.tone} />;
    case 'diffle-callout':
      return (
        <Callout key={key} kind={element.kind}>
          <TourContent of={node} />
        </Callout>
      );
    default:
      return null;
  }
}

/**
 * What a tab's pane holds, rendered as the article renders it; one function, so a block reads its
 * parts once per document.
 */
function partContent(part: Element): ReactNode {
  return <TourContent of={part} />;
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
