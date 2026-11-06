import { EyeOff, FileCode2 } from 'lucide-react';
import { FilePath } from '@/client/FilePath.js';
import { useGraph } from '@/client/graph/state.js';
import type { GraphNode } from '@/shared/protocol.js';
import { BODY, ENTRY, JumpChip, META, Name, SectionHeading } from './GraphDetailParts.js';

/**
 * The changed symbols the server's cap left out of the graph, file by file as it cut them, the
 * most telling first: each opens the diff, and one button draws them all.
 */
export function NotShown({ cut }: { cut: GraphNode[] }) {
  const files = new Map<string, GraphNode[]>();
  for (const n of cut) files.set(n.path, [...(files.get(n.path) ?? []), n]);
  return (
    <section className="flex flex-col gap-3" aria-label="Not in the graph">
      <SectionHeading icon={EyeOff} count={cut.length}>
        Not in the graph
      </SectionHeading>
      <p className={`m-0 ${META}`}>
        The graph draws so many changed symbols at once, whole files, tests and private helpers last. These files did
        not fit.
      </p>
      <button
        type="button"
        className={`cursor-pointer rounded-md border border-border bg-transparent py-1 text-foreground hover:bg-hover ${BODY}`}
        onClick={() => useGraph.getState().showAll()}
      >
        Draw all {cut.length} too (slower)
      </button>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {[...files].map(([path, nodes]) => (
          <li key={path} className={ENTRY}>
            <span className={`inline-flex items-center gap-1.5 ${BODY}`}>
              <FileCode2 size="0.875rem" className="shrink-0 text-muted" />
              <FilePath path={path} />
            </span>
            {nodes.map((n) => (
              // The chip leads, in a column as wide as a four-digit chip, as the usage lines lay theirs out.
              <span key={n.id} className="flex min-w-0 items-center gap-2">
                <span className="w-14 shrink-0">
                  <JumpChip path={n.path} line={n.line} />
                </span>
                <Name node={n} />
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
