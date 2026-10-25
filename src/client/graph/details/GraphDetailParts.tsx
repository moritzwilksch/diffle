import { ArrowUpRight, Crosshair, FileCode2, Link2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import { FilePath } from '@/client/FilePath.js';
import { Markdown } from '@/client/Markdown.js';
import { kindColor, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { useGraph } from '@/client/graph/state.js';
import { type Signature, signatureOf } from './useSignatures.js';

// The panel's type scale: titles, then names and prose, then everything around them.
export const TITLE = 'text-[0.9375rem] font-semibold';
export const BODY = 'text-[0.8125rem]';
export const META = 'text-[0.75rem] text-muted';
/** One entry of a list: a card, so its name, jumps and signature read as one and the next stands apart. */
export const ENTRY =
  'flex flex-col gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-card p-3 transition-colors hover:border-accent';

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
  action,
  children,
}: {
  icon: LucideIcon;
  count?: number;
  /** A control at the heading's end, acting on the whole section. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <h3
      className={`sticky top-0 z-[1] -mx-4 my-0 flex items-center gap-1.5 border-b border-border bg-surface px-4 py-2 ${BODY} font-semibold`}
    >
      <Icon size="0.875rem" className="text-muted" />
      {children}
      {count != null && <span className="font-normal text-muted">{count}</span>}
      {action && <span className="ml-auto">{action}</span>}
    </h3>
  );
}

/**
 * A symbol as the graph draws it: its kind's icon and colour, its name in monospace; a file as
 * everywhere in diffle, or behind `icon` in place of the file icon.
 */
export function Name({
  node,
  icon: Icon = FileCode2,
  className,
}: {
  node: GraphNode;
  icon?: LucideIcon;
  className?: string;
}) {
  const color = kindColor(node.kind);
  if (node.kind === 1)
    return (
      <span className={twMerge(`inline-flex items-center gap-1.5 ${BODY}`, className)}>
        <Icon size="0.875rem" className="shrink-0 text-muted" />
        <FilePath path={node.path} />
      </span>
    );
  return (
    // A long name, a test's sentence of one, gives way with an ellipsis rather than widen the panel.
    <span className={twMerge(`inline-flex max-w-full min-w-0 items-center gap-1.5 font-mono ${BODY}`, className)}>
      <KindIcon kind={node.kind} size="0.875rem" className="shrink-0" />
      <span className="min-w-0 truncate" style={color ? { color } : undefined} title={node.name}>
        {node.name}
      </span>
    </span>
  );
}

/** The two jumps a symbol row offers, with the review's symbol popover icons for the same jumps. */
export type JumpKind = 'definition' | 'reference';
const JUMPS: Record<JumpKind, { icon: LucideIcon; label: string }> = {
  definition: { icon: Crosshair, label: 'Definition' },
  reference: { icon: Link2, label: 'Usages' },
};

/**
 * Where to jump, one labelled row each: the file, then a chip per line that opens the diff there.
 * Every jump in the panel looks like this, so it is plain which clicks leave the graph.
 */
export function Jumps({ rows }: { rows: { to: JumpKind; path: string; lines: number[] }[] }) {
  return (
    // Centred, not on the baseline: the truncated path has none of its own, so its box's bottom edge
    // would stand in and push the row below its label.
    <div className={`grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 ${META}`}>
      {rows.map(({ to, path, lines }) => {
        const { icon: Icon, label } = JUMPS[to];
        return (
          <div key={to} className="contents">
            <span className="inline-flex items-center gap-1">
              <Icon size="0.75rem" className="shrink-0 self-center" />
              {label}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="flex min-w-[4rem]">
                <ShortPath path={path} />
              </span>
              {/* The chips keep beside the path, which gives way first; many of them wrap among themselves. */}
              <span className="flex max-w-[55%] shrink-0 flex-wrap gap-1">
                {[...lines]
                  .sort((a, b) => a - b)
                  .map((line) => (
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

/** Opens the diff at `path:line`. */
export function JumpChip({ path, line }: { path: string; line: number }) {
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
