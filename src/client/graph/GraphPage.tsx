import { useEffect, useMemo, useState } from 'react';
import { api } from '@/client/api.js';
import { Button } from '@/client/ui/Button.js';
import type { GraphResponse } from '@/shared/protocol.js';
import { GraphCanvas } from './GraphCanvas.js';
import { GraphDetails } from './GraphDetails.js';
import { isTest, keepNodes } from './filters.js';
import { nodeSize } from './labels.js';
import { layout } from './layout.js';
import { byFile, rank } from './rank.js';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; graph: GraphResponse };

/** Prototype: the change graph on a page of its own (`#graph`), to judge before it joins the review. */
export function GraphPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [files, setFiles] = useState(false);
  const [consumers, setConsumers] = useState(true);
  const [tests, setTests] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const fetchGraph = () => {
    setLoad({ state: 'loading' });
    api.lspGraph().then(
      (graph) => setLoad({ state: 'ready', graph }),
      (e: unknown) => setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  };
  useEffect(fetchGraph, []);

  const shown = useMemo(() => {
    if (load.state !== 'ready') return null;
    const graph = keepNodes(load.graph, (n) => (consumers || n.status !== 'consumer') && (tests || !isTest(n)));
    return files ? byFile(graph) : graph;
  }, [load, files, consumers, tests]);
  const placed = useMemo(() => shown && layout(shown, rank(shown), (n) => nodeSize(n, !files), !files), [shown, files]);

  const changed = shown?.nodes.filter((n) => n.status !== 'consumer').length ?? 0;
  return (
    <div className="flex h-screen flex-col bg-canvas font-sans text-[13px] text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-[14px] font-semibold">Change graph</h1>
        {shown && (
          <span className="text-muted">
            {changed} changed · {shown.nodes.length - changed} using them · {shown.edges.length} links
          </span>
        )}
        {load.state === 'ready' && load.graph.truncated && <span className="text-warn">truncated</span>}
        {load.state === 'ready' && load.graph.inconclusive && (
          <span className="text-warn" title={load.graph.inconclusive}>
            may be incomplete
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button aria-pressed={files} onClick={() => (setFiles(!files), setSelected(null))}>
            {files ? 'Symbols' : 'Files'}
          </Button>
          <Button aria-pressed={!consumers} onClick={() => (setConsumers(!consumers), setSelected(null))}>
            {consumers ? 'Hide users' : 'Show users'}
          </Button>
          <Button aria-pressed={tests} onClick={() => (setTests(!tests), setSelected(null))}>
            {tests ? 'Hide tests' : 'Show tests'}
          </Button>
          <Button onClick={fetchGraph}>Reload</Button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {load.state === 'loading' && <p className="p-4 text-muted">Asking the language servers…</p>}
          {load.state === 'error' && <p className="p-4 text-danger">{load.message}</p>}
          {placed && shown && shown.nodes.length === 0 && (
            <p className="p-4 text-muted">No changed functions, classes or types in this diff.</p>
          )}
          {placed && shown && shown.nodes.length > 0 && (
            <GraphCanvas placed={placed} clustered={!files} selected={selected} onSelect={setSelected} />
          )}
        </div>
        {shown && (
          <aside className="w-[28rem] shrink-0 overflow-y-auto border-l border-border">
            <GraphDetails graph={shown} selected={selected} />
          </aside>
        )}
      </main>
    </div>
  );
}
