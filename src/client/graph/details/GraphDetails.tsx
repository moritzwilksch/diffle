import { LayerArrowDown, LayerArrowUp, Link2, MoveDown } from 'lucide-react';
import { useMemo } from 'react';
import { KIND_LABEL, kindGroup } from '@/client/lsp/symbolKind.js';
import { bySource } from '@/client/graph/layout/order.js';
import { edgeKey } from '@/client/graph/layout/rank.js';
import { useGraph, type View } from '@/client/graph/state.js';
import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { BODY, Code, ENTRY, Jumps, META, Name, SectionHeading, StatusWord, TITLE } from './GraphDetailParts.js';
import { Links, type UsedAt } from './Links.js';
import { NotShown } from './NotShown.js';
import { peekLinks } from './peekLinks.js';
import { useSignatures } from './useSignatures.js';

const NONE: GraphNode[] = [];
const PANEL = `flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface px-4 pb-4 ${BODY}`;

/**
 * What the side panel says in graph view: the selected node or arrow, else a hint to select one and
 * what the graph left out. A name selects that node in the graph; a `:line` chip opens the diff there.
 */
export function GraphDetails() {
  const view = useGraph((s) => s.view);
  const selected = useGraph((s) => s.selected);
  const selectedEdge = useGraph((s) => s.selectedEdge);
  const cut = useGraph((s) => (s.load.state === 'ready' ? s.load.graph.cut : NONE));
  if (!view) return <aside className={PANEL} />;
  if (selectedEdge && view.via.has(selectedEdge)) return <EdgeDetails view={view} edge={selectedEdge} />;
  const node = view.graph.nodes.find((n) => n.id === selected);
  if (!node)
    return (
      <aside className={PANEL}>
        <p className={`m-0 pt-6 text-center ${META}`}>Select a box or an arrow to see its links.</p>
        {cut.length > 0 && <NotShown cut={cut} />}
      </aside>
    );
  return <NodeDetails view={view} node={node} />;
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
  const used = useMemo(() => (view.graph === view.symbols ? undefined : usedAt(view)), [view]);
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
        icon={LayerArrowUp}
        title="Used by"
        edges={usedBy}
        other={(e) => byId.get(e.from)}
        site={(n) => n.path}
        used={used}
        signatures={signatures}
        onPeek={(entries) => void peekLinks('references', node, entries)}
      />
      <Links
        icon={LayerArrowDown}
        title="Uses"
        edges={uses}
        other={(e) => byId.get(e.to)}
        site={() => node.path}
        used={used}
        signatures={signatures}
        onPeek={(entries) => void peekLinks('uses', node, entries)}
      />
      {node.moreConsumers ? (
        <p className={META}>and {node.moreConsumers} more unchanged dependents, not drawn</p>
      ) : null}
    </aside>
  );
}

/** For a file arrow, the symbols each of its reference lines uses, from the symbol links behind it. */
function usedAt(view: View): (e: GraphEdge) => UsedAt {
  const symbols = new Map(view.symbols.nodes.map((n) => [n.id, n]));
  return (e) => {
    const byLine: UsedAt = new Map();
    for (const link of view.via.get(edgeKey(e)) ?? []) {
      const to = symbols.get(link.to);
      if (!to) continue;
      for (const line of link.lines) {
        const at = byLine.get(line) ?? [];
        if (!at.some((n) => n.id === to.id)) byLine.set(line, [...at, to].sort(bySource));
      }
    }
    return byLine;
  };
}

/** An arrow: its two ends, then every symbol pair behind it with the lines that make the link. */
function EdgeDetails({ view, edge }: { view: View; edge: string }) {
  const shown = useMemo(() => new Map(view.graph.nodes.map((n) => [n.id, n])), [view]);
  const symbols = useMemo(() => new Map(view.symbols.nodes.map((n) => [n.id, n])), [view]);
  // In source order of the user, then of what it uses.
  const behind = useMemo(() => {
    const at = (id: string) => symbols.get(id);
    return [...(view.via.get(edge) ?? [])].sort((a, b) => {
      const [ua, ub, ta, tb] = [at(a.from), at(b.from), at(a.to), at(b.to)];
      return (ua && ub ? bySource(ua, ub) : 0) || (ta && tb ? bySource(ta, tb) : 0);
    });
  }, [view, edge, symbols]);
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
      <div className="flex flex-col gap-2">
        {behind.map((e) => {
          const [user, used] = [symbols.get(e.from), symbols.get(e.to)];
          if (!user || !used) return null;
          return (
            <section key={edgeKey(e)} className={ENTRY}>
              <Pair user={user} used={used} />
              <Jumps
                rows={[
                  { to: 'definition', path: used.path, lines: [used.line] },
                  { to: 'reference', path: user.path, lines: e.lines },
                ]}
              />
              <Code signature={signatures.get(used.id)} path={used.path} />
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/** One end above the other, as a call stack reads: the user, then what it calls or uses. */
function Pair({ user, used, className = '' }: { user: GraphNode; used: GraphNode; className?: string }) {
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <Name node={user} />
      <span className={`inline-flex items-center gap-1 ${META}`}>
        <MoveDown size="0.8125rem" /> {kindGroup(used.kind) === 'callable' ? 'calls' : 'uses'}
      </span>
      <Name node={used} />
    </div>
  );
}
