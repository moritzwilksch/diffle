import { FileCode2 } from 'lucide-react';
import { useMemo } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { Markdown } from '@/client/Markdown.js';
import { KIND_LABEL, kindGroup, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { useGraph } from './state.js';
import { type Signature, signatureOf, type Signatures, useSignatures } from './useSignatures.js';

const STATUS_LABEL: Record<GraphNode['status'], string> = {
  added: 'added',
  modified: 'modified',
  consumer: 'unchanged, uses the change',
};

const KIND_TEXT: Record<string, string> = {
  type: 'text-kind-type',
  callable: 'text-kind-callable',
  value: 'text-kind-value',
};

/**
 * The selected node with its hover, then what it uses and what uses it, each with its signature:
 * reading `f(container: Container)` beside `Container(id: int, content: Content)` shows why `f`
 * depends on `Content`. A name selects that node in the graph; a location jumps into the diff.
 */
export function GraphDetails() {
  const graph = useGraph((s) => s.view?.graph);
  const selected = useGraph((s) => s.selected);
  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n])), [graph]);
  const node = selected ? byId.get(selected) : undefined;
  const uses = useMemo(() => graph?.edges.filter((e) => e.from === selected) ?? [], [graph, selected]);
  const usedBy = useMemo(() => graph?.edges.filter((e) => e.to === selected) ?? [], [graph, selected]);
  const asked = useMemo(
    () => [node, ...uses.map((e) => byId.get(e.to)), ...usedBy.map((e) => byId.get(e.from))].filter((n) => n != null),
    [node, uses, usedBy, byId],
  );
  const signatures = useSignatures(graph, asked);

  if (!node)
    return (
      <aside className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-surface p-4 text-[0.8125rem] text-muted">
        <p>An arrow points from code to the code it uses. Entry points sit at the top, core code at the bottom.</p>
        <p>Framed boxes changed: green added, blue modified. Dashed boxes are unchanged code using the change.</p>
        <p>Select a box for its signature and links. Enter or a double-click opens it in the diff; M returns.</p>
      </aside>
    );
  return (
    <aside className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface p-4 text-[0.8125rem]">
      <div className="flex flex-col gap-1">
        <Name node={node} className="text-[0.875rem]" />
        <div className="text-muted">
          {KIND_LABEL[node.kind]} · {STATUS_LABEL[node.status]}
        </div>
        <Location path={node.path} lines={[node.line]} />
        <Code signature={signatures.get(node.id)} path={node.path} full />
      </div>
      <Links title="Uses" edges={uses} other={(e) => byId.get(e.to)} site={() => node.path} signatures={signatures} />
      <Links
        title="Used by"
        edges={usedBy}
        other={(e) => byId.get(e.from)}
        site={(n) => n.path}
        signatures={signatures}
      />
      {node.moreConsumers ? (
        <p className="text-muted">and {node.moreConsumers} more unchanged users, not drawn</p>
      ) : null}
    </aside>
  );
}

function Links({
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
  if (!edges.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-[0.6875rem] font-semibold tracking-[0.06em] text-muted uppercase">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {edges.map((e) => {
          const n = other(e);
          if (!n) return null;
          return (
            <li key={`${e.from}>${e.to}`} className="flex flex-col gap-1">
              <button
                className="cursor-pointer border-0 bg-transparent p-0 text-left hover:underline"
                onClick={() => useGraph.getState().select(n.id)}
                title="Select in the graph"
              >
                <Name node={n} />
              </button>
              <Location path={site(n)} lines={e.lines} />
              <Code signature={signatures.get(n.id)} path={n.path} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A symbol as the graph draws it: its kind's icon and colour, its name in monospace. */
function Name({ node, className }: { node: GraphNode; className?: string }) {
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
function Location({ path, lines }: { path: string; lines: number[] }) {
  const pick = useGraph((s) => s.pick);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[0.75rem] text-muted">
      <FileCode2 size="0.75rem" className="shrink-0" />
      <FilePath path={path} className="text-[0.75rem]" />
      {lines.map((line) => (
        <button
          key={line}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono text-accent hover:underline"
          onClick={() => pick({ path, line })}
          title="Open in the diff"
        >
          :{line}
        </button>
      ))}
    </span>
  );
}

/** A signature as the hover tooltip renders it, then a type's members; `full` keeps the hover's docs. */
function Code({ signature, path, full = false }: { signature: Signature | undefined; path: string; full?: boolean }) {
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
