import { ArrowDown, ArrowDownToLine, ArrowUpFromLine, Link2, Waypoints } from 'lucide-react';
import { useMemo } from 'react';
import { KIND_LABEL, kindGroup } from '@/client/lsp/symbolKind.js';
import { edgeKey } from '@/client/graph/layout/rank.js';
import { useGraph, type View } from '@/client/graph/state.js';
import type { GraphNode } from '@/shared/protocol.js';
import {
  BODY,
  Code,
  Jumps,
  LinkButton,
  Links,
  META,
  Name,
  SectionHeading,
  StatusWord,
  TITLE,
} from './GraphDetailParts.js';
import { useSignatures } from './useSignatures.js';

/** Arrows the overview lists, heaviest first. */
const STRONGEST = 8;
const PANEL = `flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface px-4 pb-4 ${BODY}`;

/**
 * What the side panel says in graph view: the selected node or arrow, else an overview. A name
 * selects that node in the graph; a `:line` chip opens the diff there.
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
      <div className="flex flex-col gap-2 pt-4">
        <Name node={node} className={TITLE} />
        <div className={META}>
          {KIND_LABEL[node.kind]} · <StatusWord status={node.status} />
        </div>
        <Jumps rows={[{ to: 'definition', path: node.path, lines: [node.line] }]} />
        <Code signature={signatures.get(node.id)} path={node.path} full />
      </div>
      <Links
        icon={ArrowUpFromLine}
        title="Used by"
        edges={usedBy}
        other={(e) => byId.get(e.from)}
        site={(n) => n.path}
        signatures={signatures}
      />
      <Links
        icon={ArrowDownToLine}
        title="Uses"
        edges={uses}
        other={(e) => byId.get(e.to)}
        site={() => node.path}
        signatures={signatures}
      />
      {node.moreConsumers ? <p className={META}>and {node.moreConsumers} more unchanged users, not drawn</p> : null}
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
      <Pair user={from} used={to} className="pt-4" />
      <SectionHeading icon={Link2} count={behind.length}>
        Links
      </SectionHeading>
      {behind.map((e) => {
        const [user, used] = [symbols.get(e.from), symbols.get(e.to)];
        if (!user || !used) return null;
        return (
          <section key={edgeKey(e)} className="flex flex-col gap-1.5">
            <Pair user={user} used={used} />
            <Jumps
              rows={[
                { to: 'reference', path: user.path, lines: e.lines },
                { to: 'definition', path: used.path, lines: [used.line] },
              ]}
            />
            <Code signature={signatures.get(used.id)} path={used.path} />
          </section>
        );
      })}
    </aside>
  );
}

/** One end above the other, as a call stack reads: the user, then what it calls or uses. */
function Pair({ user, used, className = '' }: { user: GraphNode; used: GraphNode; className?: string }) {
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <Name node={user} />
      <span className={`inline-flex items-center gap-1 ${META}`}>
        <ArrowDown size="0.8125rem" /> {kindGroup(used.kind) === 'callable' ? 'calls' : 'uses'}
      </span>
      <Name node={used} />
    </div>
  );
}

/** Before anything is selected: the graph's heaviest arrows. */
function Overview({ view }: { view: View }) {
  const byId = useMemo(() => new Map(view.graph.nodes.map((n) => [n.id, n])), [view]);
  const strongest = useMemo(() => {
    const weight = (key: string) => (view.via.get(key) ?? []).reduce((sum, e) => sum + e.lines.length, 0);
    return [...view.graph.edges]
      .map((e) => ({ e, w: weight(edgeKey(e)) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, STRONGEST);
  }, [view]);
  return (
    <aside className={PANEL}>
      {strongest.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeading icon={Waypoints} count={strongest.length}>
            Strongest links
          </SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
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
                      <span className={META}>×{w}</span>
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
