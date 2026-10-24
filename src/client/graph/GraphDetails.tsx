import { useMemo } from 'react';
import { Markdown } from '@/client/Markdown.js';
import { KIND_LABEL } from '@/client/lsp/symbolKind.js';
import type { GraphEdge, GraphNode, GraphResponse } from '@/shared/protocol.js';
import { type Signature, signatureOf, type Signatures, useSignatures } from './useSignatures.js';

const STATUS_LABEL: Record<GraphNode['status'], string> = {
  added: 'added',
  modified: 'modified',
  consumer: 'unchanged, uses the change',
};

/**
 * The selected node with its hover, then what it uses and what uses it, each with its signature:
 * reading `f(container: Container)` beside `Container(id: int, content: Content)` shows why `f`
 * depends on `Content`.
 */
export function GraphDetails({ graph, selected }: { graph: GraphResponse; selected: string | null }) {
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const node = selected ? byId.get(selected) : undefined;
  const uses = useMemo(() => graph.edges.filter((e) => e.from === selected), [graph, selected]);
  const usedBy = useMemo(() => graph.edges.filter((e) => e.to === selected), [graph, selected]);
  const asked = useMemo(
    () => [node, ...uses.map((e) => byId.get(e.to)), ...usedBy.map((e) => byId.get(e.from))].filter((n) => n != null),
    [node, uses, usedBy, byId],
  );
  const signatures = useSignatures(graph, asked);

  if (!node)
    return (
      <div className="flex flex-col gap-2 p-4 text-muted">
        <p>An arrow points from code to the code it uses. Entry points sit left, core code right.</p>
        <p>Framed boxes changed: green added, blue modified. Dashed boxes are unchanged code using the change.</p>
        <p>Click a box for its signature and links; drag to pan, scroll to zoom, double-click to fit.</p>
      </div>
    );
  const signature = signatures.get(node.id);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[13px] break-all">{node.kind === 1 ? node.path : node.name}</div>
        <div className="text-muted">
          {KIND_LABEL[node.kind]} · {STATUS_LABEL[node.status]}
        </div>
        <div className="font-mono text-[11.5px] break-all text-muted">
          {node.path}:{node.line}
        </div>
        <Code signature={signature} path={node.path} full />
      </div>
      <Links title="Uses" edges={uses} other={(e) => byId.get(e.to)} site={node.path} signatures={signatures} />
      <Links title="Used by" edges={usedBy} other={(e) => byId.get(e.from)} signatures={signatures} />
      {node.moreConsumers ? (
        <p className="text-muted">and {node.moreConsumers} more unchanged users, not drawn</p>
      ) : null}
    </div>
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
  /** The file holding the references, when it is not the other node's. */
  site?: string;
  signatures: Signatures;
}) {
  if (!edges.length) return null;
  return (
    <section>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <ul className="flex flex-col gap-3">
        {edges.map((e) => {
          const n = other(e);
          if (!n) return null;
          return (
            <li key={`${e.from}>${e.to}`} className="flex flex-col gap-1">
              <span className="font-mono text-[12px]">{n.kind === 1 ? n.path : n.name}</span>
              <span className="font-mono text-[11px] break-all text-muted">
                {site ?? n.path}:{e.lines.join(', ')}
              </span>
              <Code signature={signatures.get(n.id)} path={n.path} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A signature as the hover tooltip renders it, then a type's members; `full` keeps the hover's docs. */
function Code({ signature, path, full = false }: { signature: Signature | undefined; path: string; full?: boolean }) {
  if (!signature?.hover && !signature?.members) return null;
  const text = [signature.hover && (full ? signature.hover : signatureOf(signature.hover)), signature.members]
    .filter(Boolean)
    .join('\n\n');
  return (
    <div className="rounded-md border border-border bg-surface px-2 py-1 [&_pre]:break-all [&_pre]:whitespace-pre-wrap">
      <Markdown text={text} path={path} highlight />
    </div>
  );
}
