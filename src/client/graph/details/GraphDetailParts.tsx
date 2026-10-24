import { ArrowUpRight, ChevronRight, Crosshair, FileCode2, Link2, type LucideIcon } from 'lucide-react';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { twMerge } from 'tailwind-merge';
import { FilePath } from '@/client/FilePath.js';
import { Markdown } from '@/client/Markdown.js';
import { kindGroup, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { isTest } from '@/client/graph/filters.js';
import { canvasControl } from '@/client/graph/GraphCanvas.js';
import { bySource } from '@/client/graph/layout/order.js';
import { edgeKey } from '@/client/graph/layout/rank.js';
import { useGraph } from '@/client/graph/state.js';
import { type Signature, signatureOf, type Signatures } from './useSignatures.js';

// The panel's type scale: titles, then names and prose, then everything around them.
export const TITLE = 'text-[0.9375rem] font-semibold';
export const BODY = 'text-[0.8125rem]';
export const META = 'text-[0.75rem] text-muted';
/** One entry of a list: a card, so its name, jumps and signature read as one and the next stands apart. */
export const ENTRY =
  'flex flex-col gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-card p-3 transition-colors hover:border-accent';

const KIND_TEXT: Record<string, string> = {
  type: 'text-kind-type',
  callable: 'text-kind-callable',
  value: 'text-kind-value',
};

/** Rows a list shows before it folds behind "Show all". */
const FOLD_AFTER = 6;

/** A change in words, coloured as the diff colours it. */
export function StatusWord({ status }: { status: GraphNode['status'] }) {
  if (status === 'added') return <span className="text-add">added</span>;
  if (status === 'modified') return <span className="text-accent">modified</span>;
  return <span className="text-muted">unchanged</span>;
}

/**
 * A section's heading: what the section holds and how many, kept in view while its list scrolls
 * past, so a long panel stays easy to find one's way in.
 */
export function SectionHeading({
  icon: Icon,
  count,
  children,
}: {
  icon: LucideIcon;
  count?: number;
  children: ReactNode;
}) {
  return (
    <h3
      className={`sticky top-0 z-[1] -mx-4 my-0 flex items-center gap-1.5 border-b border-border bg-surface px-4 py-2 ${BODY} font-semibold`}
    >
      <Icon size="0.875rem" className="text-muted" />
      {children}
      {count != null && <span className="font-normal text-muted">{count}</span>}
    </h3>
  );
}

/** A plain button that reads as a link, without the browser's button chrome. */
function LinkButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...props}
      className={twMerge('cursor-pointer border-0 bg-transparent p-0 text-left hover:underline', className)}
    />
  );
}

/**
 * The nodes at the other end of `edges`: each selects itself in the graph by its name, and opens
 * the diff where it is defined and where the link sits. Source before tests, each in source order;
 * a long list folds.
 */
export function Links({
  icon,
  title,
  edges,
  other,
  site,
  used,
  signatures,
}: {
  icon: LucideIcon;
  title: string;
  edges: GraphEdge[];
  other: (e: GraphEdge) => GraphNode | undefined;
  /** The file holding the references, given the other end. */
  site: (other: GraphNode) => string;
  /** File view only: the symbols each reference line uses. */
  used?: (e: GraphEdge) => UsedAt;
  signatures: Signatures;
}) {
  const [all, setAll] = useState(false);
  const rows = edges
    .map((e) => ({ e, n: other(e) }))
    .filter((r): r is { e: GraphEdge; n: GraphNode } => r.n != null)
    .sort((a, b) => Number(isTest(a.n)) - Number(isTest(b.n)) || bySource(a.n, b.n));
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, FOLD_AFTER);
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading icon={icon} count={rows.length}>
        {title}
      </SectionHeading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {shown.map(({ e, n }) => (
          <li
            key={`${e.from}>${e.to}`}
            className={`${ENTRY} cursor-pointer`}
            // The card frames its node in the graph, as a double-click there does; its own buttons and
            // a text selection in it keep their clicks.
            onClick={(ev) => {
              if ((ev.target as Element).closest('button, a') || window.getSelection()?.toString()) return;
              canvasControl.frame(n.id);
            }}
            onPointerEnter={() => useGraph.getState().hoverEdge(edgeKey(e))}
            onPointerLeave={() => useGraph.getState().hoverEdge(null)}
          >
            <NodeRow node={n} />
            <Jumps
              rows={[
                ...(n.kind === 1 ? [] : [{ to: 'definition' as const, path: n.path, lines: [n.line] }]),
                { to: 'reference' as const, path: site(n), lines: e.lines, used: used?.(e) },
              ]}
            />
            <Code signature={signatures.get(n.id)} path={n.path} />
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button
          type="button"
          className={`cursor-pointer rounded-md border border-border bg-transparent py-1 text-foreground hover:bg-hover ${BODY}`}
          onClick={() => setAll(true)}
        >
          Show all {rows.length}
        </button>
      )}
    </section>
  );
}

/** A linked node's name, selecting and framing it in the graph; the chevron says the row leads there. */
function NodeRow({ node }: { node: GraphNode }) {
  return (
    <LinkButton
      className="group flex items-center justify-between gap-2 hover:no-underline"
      onClick={() => canvasControl.frame(node.id)}
    >
      <span className="group-hover:underline">
        <Name node={node} />
      </span>
      <ChevronRight size="0.875rem" className="shrink-0 text-muted" />
    </LinkButton>
  );
}

/** A symbol as the graph draws it: its kind's icon and colour, its name in monospace; a file as everywhere in diffle. */
export function Name({ node, className }: { node: GraphNode; className?: string }) {
  if (node.kind === 1)
    return (
      <span className={twMerge(`inline-flex items-center gap-1.5 ${BODY}`, className)}>
        <FileCode2 size="0.875rem" className="shrink-0 text-muted" />
        <FilePath path={node.path} />
      </span>
    );
  return (
    <span className={twMerge(`inline-flex items-center gap-1.5 font-mono ${BODY}`, className)}>
      <KindIcon
        kind={node.kind}
        size="0.875rem"
        className={`shrink-0 ${KIND_TEXT[kindGroup(node.kind)] ?? 'text-muted'}`}
      />
      {node.name}
    </span>
  );
}

/** The two jumps a symbol row offers, with the review's symbol popover icons for the same jumps. */
export type JumpKind = 'definition' | 'reference';
const JUMPS: Record<JumpKind, { icon: LucideIcon; label: string }> = {
  definition: { icon: Crosshair, label: 'Defined' },
  reference: { icon: Link2, label: 'Used at' },
};

/** The symbols a file arrow's reference lines use, by line. */
export type UsedAt = Map<number, GraphNode[]>;

/**
 * Where to jump, one labelled row each: the file, then a chip per line that opens the diff there.
 * Every jump in the panel looks like this, so it is plain which clicks leave the graph. With `used`,
 * the chips stack, each beside the symbols its line uses.
 */
export function Jumps({ rows }: { rows: { to: JumpKind; path: string; lines: number[]; used?: UsedAt }[] }) {
  return (
    <div className={`grid grid-cols-[5.25rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 ${META}`}>
      {rows.map(({ to, path, lines: given, used }) => {
        const { icon: Icon, label } = JUMPS[to];
        const lines = [...given].sort((a, b) => a - b);
        if (used)
          return (
            <div key={to} className="contents">
              <span className="inline-flex items-center gap-1">
                <Icon size="0.75rem" className="shrink-0 self-center" />
                {label}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileCode2 size="0.75rem" className="shrink-0" />
                  <ShortPath path={path} />
                </span>
                {lines.map((line) => (
                  <span key={line} className="flex min-w-0 items-center gap-2">
                    {/* A column as wide as a four-digit chip, so the names line up. */}
                    <span className="w-14 shrink-0">
                      <JumpChip path={path} line={line} />
                    </span>
                    <span className="flex min-w-0 flex-wrap gap-x-2 text-foreground">
                      {(used.get(line) ?? []).map((n) => (
                        <Name key={n.id} node={n} className="text-[0.75rem]" />
                      ))}
                    </span>
                  </span>
                ))}
              </span>
            </div>
          );
        return (
          <div key={to} className="contents">
            <span className="inline-flex items-center gap-1">
              <Icon size="0.75rem" className="shrink-0 self-center" />
              {label}
            </span>
            <span className="flex min-w-0 items-start gap-1.5">
              <span className="flex min-w-[4rem] items-center gap-1.5">
                <FileCode2 size="0.75rem" className="shrink-0" />
                <ShortPath path={path} />
              </span>
              {/* The chips keep beside the path, which gives way first; many of them wrap among themselves. */}
              <span className="flex max-w-[55%] shrink-0 flex-wrap gap-1">
                {lines.map((line) => (
                  <JumpChip key={line} path={path} line={line} />
                ))}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A path on one line, styled as `FilePath` styles paths. The folders give way from the start, so
 * the file name next to the line chips stays.
 */
function ShortPath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <span className="block min-w-0 truncate text-left font-mono text-[0.75rem] [direction:rtl]" title={path}>
      <bdi>
        <span className="text-muted">{path.slice(0, cut)}</span>
        <span className="font-semibold text-foreground">{path.slice(cut)}</span>
      </bdi>
    </span>
  );
}

function JumpChip({ path, line }: { path: string; line: number }) {
  return (
    <button
      type="button"
      onClick={() => useGraph.getState().pick({ path, line })}
      aria-label={`Open ${path}:${line} in the diff`}
      className="inline-flex cursor-pointer items-center gap-0.5 rounded-sm border-0 bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-1.5 py-px font-mono text-[0.75rem] text-accent hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]"
    >
      :{line}
      <ArrowUpRight size="0.6875rem" />
    </button>
  );
}

/** A signature as the hover tooltip renders it, then a type's members; `full` keeps the hover's docs. */
export function Code({
  signature,
  path,
  full = false,
}: {
  signature: Signature | undefined;
  path: string;
  full?: boolean;
}) {
  if (!signature?.hover && !signature?.members) return null;
  const text = [signature.hover && (full ? signature.hover : signatureOf(signature.hover)), signature.members]
    .filter(Boolean)
    .join('\n\n');
  return (
    // `.markdown pre code` sets `white-space: pre`, so the wrap goes on the code, not the block.
    <div className="hover-markdown rounded-lg bg-[color-mix(in_srgb,var(--bg-3)_45%,transparent)] px-3 py-2 text-[0.75rem] leading-normal [&_hr]:my-2 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color-mix(in_srgb,var(--border)_50%,transparent)] [&_p]:text-[0.75rem] [&_pre_code]:[overflow-wrap:anywhere] [&_pre_code]:whitespace-pre-wrap">
      <Markdown text={text} path={path} highlight />
    </div>
  );
}
