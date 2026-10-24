import type { GraphEdge, GraphNode, GraphResponse } from '@/shared/protocol.js';
import { KIND_LABEL } from '@/client/lsp/symbolKind.js';

const STATUS_LABEL: Record<GraphNode['status'], string> = {
  added: 'added',
  modified: 'modified',
  consumer: 'unchanged, uses the change',
};

/** The selected node: where it is, what it uses, and what uses it, with the lines that do. */
export function GraphDetails({ graph, selected }: { graph: GraphResponse; selected: string | null }) {
  const node = graph.nodes.find((n) => n.id === selected);
  if (!node)
    return (
      <div className="flex flex-col gap-2 p-4 text-muted">
        <p>An arrow points from code to the code it uses. Entry points sit left, core code right.</p>
        <p>Framed boxes changed: green added, blue modified. Dashed boxes are unchanged code using the change.</p>
        <p>Click a box for its links; drag to pan, scroll to zoom, double-click to fit.</p>
      </div>
    );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const uses = graph.edges.filter((e) => e.from === node.id);
  const usedBy = graph.edges.filter((e) => e.to === node.id);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="font-mono text-[13px] break-all">{node.kind === 1 ? node.path : node.name}</div>
        <div className="text-muted">
          {KIND_LABEL[node.kind]} · {STATUS_LABEL[node.status]}
        </div>
        <div className="font-mono text-[11.5px] break-all text-muted">
          {node.path}:{node.line}
        </div>
      </div>
      <Links title="Uses" edges={uses} name={(e) => byId.get(e.to)} at={(e) => `${node.path}:${e.lines.join(', ')}`} />
      <Links
        title="Used by"
        edges={usedBy}
        name={(e) => byId.get(e.from)}
        at={(e) => `${byId.get(e.from)?.path}:${e.lines.join(', ')}`}
      />
      {node.moreConsumers ? <p className="text-muted">and {node.moreConsumers} more unchanged users, not drawn</p> : null}
    </div>
  );
}

function Links({
  title,
  edges,
  name,
  at,
}: {
  title: string;
  edges: GraphEdge[];
  name: (e: GraphEdge) => GraphNode | undefined;
  at: (e: GraphEdge) => string;
}) {
  if (!edges.length) return null;
  return (
    <section>
      <h3 className="mb-1 font-semibold">{title}</h3>
      <ul className="flex flex-col gap-1">
        {edges.map((e) => {
          const n = name(e);
          return (
            <li key={`${e.from}>${e.to}`}>
              <span className="font-mono text-[12px]">{n?.kind === 1 ? n.path : n?.name}</span>
              <span className="block font-mono text-[11px] break-all text-muted">{at(e)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
