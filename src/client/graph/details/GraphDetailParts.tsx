import { FileCode2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { Markdown } from '@/client/Markdown.js';
import { kindGroup, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { isTest } from '@/client/graph/filters.js';
import { useGraph } from '@/client/graph/state.js';
import { type Signature, signatureOf, type Signatures } from './useSignatures.js';

const KIND_TEXT: Record<string, string> = {
  type: 'text-kind-type',
  callable: 'text-kind-callable',
  value: 'text-kind-value',
};

/** Rows a list shows before it folds behind "Show all". */
const FOLD_AFTER = 6;

export function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[0.6875rem] font-semibold tracking-[0.06em] text-muted uppercase">{children}</h3>;
}

/** A plain button that reads as a link, without the browser's button chrome. */
export function LinkButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      {...props}
      className={`cursor-pointer border-0 bg-transparent p-0 text-left hover:underline ${className ?? ''}`}
    />
  );
}

/**
 * The nodes at the other end of `edges`, each with where the references sit and its signature.
 * Source code comes before tests, and a long list folds after a few rows.
 */
export function Links({
  title,
  edges,
  other,
  site,
  signatures,
}: {
  title: string;
  edges: GraphEdge[];
  other: (e: GraphEdge) => GraphNode | undefined;
  /** The file holding the references, given the other end. */
  site: (other: GraphNode) => string;
  signatures: Signatures;
}) {
  const [all, setAll] = useState(false);
  const rows = edges
    .map((e) => ({ e, n: other(e) }))
    .filter((r): r is { e: GraphEdge; n: GraphNode } => r.n != null)
    .sort((a, b) => Number(isTest(a.n)) - Number(isTest(b.n)));
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, FOLD_AFTER);
  return (
    <section>
      <Heading>{title}</Heading>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {shown.map(({ e, n }) => (
          <li key={`${e.from}>${e.to}`} className="flex flex-col gap-1">
            <LinkButton onClick={() => useGraph.getState().select(n.id)} title="Select in the graph">
              <Name node={n} />
            </LinkButton>
            <Location path={site(n)} lines={e.lines} />
            <Code signature={signatures.get(n.id)} path={n.path} />
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <LinkButton className="mt-2 text-accent" onClick={() => setAll(true)}>
          Show all {rows.length}
        </LinkButton>
      )}
    </section>
  );
}

/** A symbol as the graph draws it: its kind's icon and colour, its name in monospace; a file as everywhere in diffle. */
export function Name({ node, className }: { node: GraphNode; className?: string }) {
  if (node.kind === 1)
    return (
      <span className={`inline-flex items-center gap-1.5 ${className ?? ''}`}>
        <FileCode2 size="0.875rem" className="shrink-0 text-muted" />
        <FilePath path={node.path} />
      </span>
    );
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono ${className ?? ''}`}>
      <KindIcon
        kind={node.kind}
        size="0.875rem"
        className={`shrink-0 ${KIND_TEXT[kindGroup(node.kind)] ?? 'text-muted'}`}
      />
      {node.name}
    </span>
  );
}

/** A file and the lines in it, each line a jump into the diff. */
export function Location({ path, lines }: { path: string; lines: number[] }) {
  const pick = useGraph((s) => s.pick);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[0.75rem] text-muted">
      <FileCode2 size="0.75rem" className="shrink-0" />
      <FilePath path={path} className="text-[0.75rem]" />
      {lines.map((line) => (
        <LinkButton
          key={line}
          className="font-mono text-accent"
          onClick={() => pick({ path, line })}
          title="Open in the diff"
        >
          :{line}
        </LinkButton>
      ))}
    </span>
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
    <div className="hover-markdown rounded-lg bg-[color-mix(in_srgb,var(--bg-3)_45%,transparent)] px-3 py-2 text-[0.75rem] leading-normal [&_hr]:my-2 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color-mix(in_srgb,var(--border)_50%,transparent)] [&_pre_code]:[overflow-wrap:anywhere] [&_pre_code]:whitespace-pre-wrap">
      <Markdown text={text} path={path} highlight />
    </div>
  );
}
