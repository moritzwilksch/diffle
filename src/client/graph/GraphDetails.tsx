import { ArrowDown } from 'lucide-react';
import { useMemo } from 'react';
import { KIND_LABEL } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { Code, Heading, LinkButton, Links, Location, Name } from './GraphDetailParts.js';
import { edgeKey } from './rank.js';
import { useGraph, type View } from './state.js';
import { useSignatures } from './useSignatures.js';

const STATUS_LABEL: Record<GraphNode['status'], string> = {
  added: 'added',
  modified: 'modified',
  consumer: 'unchanged, uses the change',
};

/** Arrows the overview lists, heaviest first. */
const STRONGEST = 8;
const PANEL = 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface p-4 text-[0.8125rem]';

/**
 * What the side panel says in graph view: the selected node or arrow, else an overview. A name
 * selects that node in the graph; a location jumps into the diff.
 */
export function GraphDetails() {
  const view = useGraph((s) => s.view);
  const selected = useGraph((s) => s.selected);
  const selectedEdge = useGraph((s) => s.selectedEdge);
  if (!view) return <aside className={PANEL} />;
  if (selectedEdge && view.via.has(selectedEdge)) return <EdgeDetails view={view} edge={selectedEdge} />;
  const node = view.graph.nodes.find((n) => n.id === selected);
  return node ? <NodeDetails view={view} node={node} /> : <Overview view={view} />;
}

/**
 * The node with its hover, then what it uses and what uses it, each with its signature: reading
 * `f(container: Container)` beside `Container(id: int, content: Content)` shows why `f` depends
 * on `Content`.
 */
function NodeDetails({ view, node }: { view: View; node: GraphNode }) {
  const { graph } = view;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const uses = useMemo(() => graph.edges.filter((e) => e.from === node.id), [graph, node]);
  const usedBy = useMemo(() => graph.edges.filter((e) => e.to === node.id), [graph, node]);
  const asked = useMemo(
    () => [node, ...uses.map((e) => byId.get(e.to)), ...usedBy.map((e) => byId.get(e.from))].filter((n) => n != null),
    [node, uses, usedBy, byId],
  );
  const signatures = useSignatures(graph, asked);
  return (
    <aside className={PANEL}>
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

/** An arrow: its two ends, then every symbol pair behind it with the lines that make the link. */
function EdgeDetails({ view, edge }: { view: View; edge: string }) {
  const shown = useMemo(() => new Map(view.graph.nodes.map((n) => [n.id, n])), [view]);
  const symbols = useMemo(() => new Map(view.symbols.nodes.map((n) => [n.id, n])), [view]);
  const behind = useMemo(() => view.via.get(edge) ?? [], [view, edge]);
  const arrow = view.graph.edges.find((e) => edgeKey(e) === edge);
  const asked = useMemo(
    () => behind.flatMap((e) => [symbols.get(e.to), symbols.get(e.from)]).filter((n) => n != null),
    [behind, symbols],
  );
  const signatures = useSignatures(view.graph, asked);
  const [from, to] = [arrow && shown.get(arrow.from), arrow && shown.get(arrow.to)];
  if (!from || !to) return <aside className={PANEL} />;
  return (
    <aside className={PANEL}>
      <div className="flex flex-col items-start gap-1">
        <Name node={from} className="text-[0.875rem]" />
        <span className="inline-flex items-center gap-1 text-muted">
          <ArrowDown size="0.875rem" /> uses
        </span>
        <Name node={to} className="text-[0.875rem]" />
      </div>
      {behind.map((e) => {
        const [user, used] = [symbols.get(e.from), symbols.get(e.to)];
        if (!user || !used) return null;
        return (
          <section key={edgeKey(e)} className="flex flex-col gap-1">
            <Heading>
              {user.kind === 1 ? 'top level' : user.name} → {used.name}
            </Heading>
            <Code signature={signatures.get(used.id)} path={used.path} />
            <Location path={user.path} lines={e.lines} />
            {user.kind !== 1 && <Code signature={signatures.get(user.id)} path={user.path} />}
          </section>
        );
      })}
    </aside>
  );
}

/** Before anything is selected: how to read the graph, an example from it, and its heaviest arrows. */
function Overview({ view }: { view: View }) {
  const byId = useMemo(() => new Map(view.graph.nodes.map((n) => [n.id, n])), [view]);
  const strongest = useMemo(() => {
    const weight = (key: string) => (view.via.get(key) ?? []).reduce((sum, e) => sum + e.lines.length, 0);
    return [...view.graph.edges]
      .map((e) => ({ e, w: weight(edgeKey(e)) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, STRONGEST);
  }, [view]);
  const example = strongest[0];
  const [exFrom, exTo] = [example && byId.get(example.e.from), example && byId.get(example.e.to)];
  return (
    <aside className={PANEL}>
      <section className="flex flex-col gap-2 text-muted">
        <p>
          An arrow points from code to the code it uses: entry points at the top, core code at the bottom. Click a box
          or an arrow for its signatures and lines; Enter or a double-click opens it in the diff.
        </p>
        {exFrom && exTo && (
          <p className="flex flex-wrap items-center gap-1.5">
            For example, <Name node={exFrom} /> uses <Name node={exTo} />
          </p>
        )}
      </section>
      {strongest.length > 0 && (
        <section>
          <Heading>Strongest links</Heading>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {strongest.map(({ e, w }) => {
              const [from, to] = [byId.get(e.from), byId.get(e.to)];
              if (!from || !to) return null;
              return (
                <li key={edgeKey(e)}>
                  <LinkButton
                    className="flex flex-col items-start gap-0.5"
                    onClick={() => useGraph.getState().selectEdge(edgeKey(e))}
                  >
                    <Name node={from} />
                    <span className="flex items-center gap-1.5 pl-2">
                      <span className="text-muted">→</span> <Name node={to} />
                      <span className="font-mono text-[0.6875rem] text-muted">×{w}</span>
                    </span>
                  </LinkButton>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </aside>
  );
}
